import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Context } from '../cli.js'
import type { Config } from '../config.js'
import { Artifacts } from '../engine/artifacts.js'
import { readFormat, renderInstructions } from '../engine/stage-file.js'
import { Trust } from '../engine/trust.js'
import { commentText, findWorkpad } from '../engine/workpad.js'
import { childEnv } from '../harness/harness.js'
import { prepare } from './run.js'
import { skillInstall } from './skill.js'

const TEMPLATES = fileURLToPath(new URL('../../templates/live/', import.meta.url))
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/
const resultSchema = z.object({ title: z.string().min(1), form: z.enum(['idea', 'story', 'plan']) })

export async function newCommand(context: Context, json: boolean): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const { config, settings, board } = prepared
  const text = await session(context, settings, config, 'new.md', { project: config.board.project })
  if (!text.ok) return fail(context, text.error)

  const parsed = parseNewTask(text.value)
  if (!parsed.ok) return fail(context, parsed.error)
  const task = await board.createTask(parsed.title, parsed.body, { state: 'backlog', form: parsed.form })
  context.stdout(json ? `${JSON.stringify({ id: task.id, title: task.title, form: parsed.form })}\n` : `Created task ${task.id}: ${task.title}\n`)
  return 0
}

export async function attachCommand(context: Context, id: string): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const { config, settings, board } = prepared
  const task = await board.getTask(id)
  if (!task) return fail(context, `task ${id} not found`)
  if (task.state !== 'needs-input' && task.state !== 'queued') return fail(context, `task ${id} does not wait for input`)

  const trust = new Trust(board)
  if (!(await trust.trusted(task.author))) return fail(context, `task ${id} was created by @${task.author}, who has no write access to the repository`)
  const comments = await trust.only(await board.listComments(id))
  const waiting = findWorkpad(comments)?.state.waiting
  const request = comments.find((comment) => comment.id === waiting?.commentId)
  const stage = waiting?.stage ?? 'story'
  const artifacts = new Artifacts(board, unavailableWorkspaces, config, context.home).read(task, comments, context.cwd)
  const text = await session(context, settings, config, 'attach.md', {
    issue: { id: task.id, title: task.title, body: task.body },
    stage,
    request: request ? commentText(request) : '(no request found)',
    artifacts: Object.entries(artifacts)
      .map(([kind, content]) => `## Artifact: ${kind}\n\n${content.trim()}`)
      .join('\n\n'),
  })
  if (!text.ok) return fail(context, text.error)

  await board.addComment(id, `Answer from a live session:\n\n${text.value.trim()}`)
  context.stdout(`Posted the answer to task ${id}. The next conveyor cycle continues the ${stage} stage.\n`)
  return 0
}

export async function harnessCommand(context: Context, id: string): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const { config, settings, board } = prepared
  const task = await board.getTask(id)
  if (!task) return fail(context, `task ${id} not found`)
  const trust = new Trust(board)
  if (!(await trust.trusted(task.author))) return fail(context, `task ${id} was created by @${task.author}, who has no write access to the repository`)
  const comments = await trust.only(await board.listComments(id))
  const pad = findWorkpad(comments)
  const pull = await board.pullRequest(id)
  const text = await session(context, settings, config, 'task.md', {
    project: config.board.project,
    issue: { id: task.id, title: task.title, body: task.body || '(empty)' },
    labels: [task.state ? `conveyor::${task.state}` : '', task.form ? `form::${task.form}` : '', task.stage ? `stage::${task.stage}` : ''].filter(Boolean).join(', ') || '(none)',
    workpad: pad ? pad.text.trim() || '(empty)' : '(none)',
    comments:
      comments
        .filter((comment) => comment.id !== pad?.id)
        .map((comment) => `@${comment.author} (${comment.createdAt}):\n${commentText(comment).trim()}`)
        .join('\n\n') || '(none)',
    pull: pull ? `${pull.url} · ${pull.state} · checks ${pull.checks}` : '(none)',
  })
  if (!text.ok) {
    context.stdout(`The session on task ${id} ended without a comment: ${text.error}.\n`)
    return 0
  }
  await board.addComment(id, `Notes from a live session:\n\n${text.value.trim()}`)
  context.stdout(`Posted the notes of the session on task ${id}.\n`)
  return 0
}

export async function helpSessionCommand(context: Context): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const { config } = prepared
  const folder = config.live.harness === 'claude' ? '.claude' : '.agents'
  const installed = [context.cwd, context.home].some((base) => existsSync(join(base, folder, 'skills', 'conveyor-help', 'SKILL.md')))
  if (!installed) skillInstall({ ...context, stdout: () => undefined }, {}, false)
  const prompt = 'Use the conveyor-help skill. Help me with the conveyor of this project: answer my questions about the workflow, the board, and the settings, or walk me through the setup.'
  const command = liveCommand(context, config, prompt)
  if (!command.ok) return fail(context, command.error)
  const code = await context.interact(command.command, command.args, { cwd: context.cwd, env: { ...childEnv(process.env), ...command.env } })
  const ended = code === 0 ? 'the help session ended.' : `the help session ended with exit code ${code} (${command.command} with model ${config.live.model}; check live.harness and live.model in the settings).`
  context.stdout(installed ? `${ended[0]?.toUpperCase()}${ended.slice(1)}\n` : `Installed the conveyor-help skill in your home directory; ${ended}\n`)
  return code === 0 ? 0 : 1
}

async function session(
  context: Context,
  settings: string,
  config: Config,
  template: string,
  variables: Record<string, unknown>,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'conveyor-live-'))
  const result = join(dir, 'result.md')
  try {
    const custom = join(settings, 'live', template)
    const source = readFileSync(existsSync(custom) ? custom : join(TEMPLATES, template), 'utf8')
    const prompt = renderInstructions(source, {
      ...variables,
      result,
      language: { docs: config.language.docs, chat: config.language.chat ?? 'the language the human uses' },
      formats: { story: readFormat(settings, 'story') },
    })
    if (!prompt.ok) return { ok: false, error: `live/${template}: ${prompt.error}` }

    const command = liveCommand(context, config, prompt.text, dir)
    if (!command.ok) return command
    const code = await context.interact(command.command, command.args, { cwd: context.cwd, env: { ...childEnv(process.env), ...command.env, CONVEYOR_RESULT: result } })

    if (!existsSync(result) || !readFileSync(result, 'utf8').trim()) {
      return { ok: false, error: code === 0 ? 'the session ended with no result' : `${command.command} exited with code ${code}; check live.harness and live.model in the settings` }
    }
    return { ok: true, value: readFileSync(result, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function parseNewTask(text: string): { ok: true; title: string; form: 'idea' | 'story' | 'plan'; body: string } | { ok: false; error: string } {
  const match = text.match(FRONTMATTER)
  if (!match) return { ok: false, error: 'the result has no frontmatter with title and form' }
  const parsed = resultSchema.safeParse(parse(match[1] ?? ''))
  if (!parsed.success) return { ok: false, error: `invalid result: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}` }
  return { ok: true, ...parsed.data, body: text.slice(match[0].length).trim() }
}

function liveCommand(
  context: Context,
  config: Config,
  prompt: string,
  dir?: string,
): { ok: true; command: string; args: string[]; env: Record<string, string> } | { ok: false; error: string } {
  const { harness, model, effort } = config.live
  const extra = dir ? ['--add-dir', dir] : []
  if (harness === 'codex') return { ok: true, command: 'codex', args: ['-m', model, '-c', `model_reasoning_effort="${effort}"`, ...extra, '--', prompt], env: {} }
  if (harness === 'claude') return { ok: true, command: 'claude', args: ['--model', model, '--effort', effort, ...extra, '--', prompt], env: {} }
  const definition = config.harnesses[harness]
  if (!definition?.interactive) {
    return { ok: false, error: `${harness} has no interactive mode for live sessions: set live.harness to claude, codex, opencode, or kilocode in local.yaml, or add harnesses.${harness}.interactive` }
  }
  const values: Record<string, string> = { prompt, model, effort, workspace: context.cwd }
  const fill = (text: string) => text.replace(/\{(prompt|model|effort|workspace)\}/g, (_, key: string) => values[key] ?? '')
  return {
    ok: true,
    command: definition.command,
    args: definition.interactive.map(fill),
    env: Object.fromEntries(
      Object.entries(definition.env)
        .filter(([, value]) => !/\{(result|temp)\}/.test(value))
        .map(([key, value]) => [key, fill(value)]),
    ),
  }
}

function fail(context: Context, error: string) {
  context.stderr(`${error}\n`)
  return 1
}

const unavailableWorkspaces = {
  prepare: () => Promise.reject(new Error('no workspace in a live session')),
  runHook: () => Promise.resolve(),
  commitFile: () => Promise.reject(new Error('no workspace in a live session')),
  commitAll: () => Promise.resolve(false),
  reset: () => Promise.reject(new Error('no workspace in a live session')),
  deleteBranch: () => Promise.resolve(),
  push: () => Promise.reject(new Error('no workspace in a live session')),
  remove: () => Promise.resolve(),
  list: () => Promise.resolve([]),
}
