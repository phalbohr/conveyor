import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Context } from '../cli.js'
import type { Config, Stage } from '../config.js'
import { Artifacts } from '../engine/artifacts.js'
import { readFormat, renderInstructions } from '../engine/stage-file.js'
import { Trust } from '../engine/trust.js'
import { commentText, findWorkpad } from '../engine/workpad.js'
import { childEnv } from '../harness/harness.js'
import { prepare } from './run.js'

const TEMPLATES = fileURLToPath(new URL('../../templates/live/', import.meta.url))
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/
const resultSchema = z.object({ title: z.string().min(1), form: z.enum(['idea', 'story', 'plan']) })

export async function newCommand(context: Context, json: boolean): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const { config, settings, board } = prepared
  const stage = stageNamed(config, 'story')
  const text = await session(context, settings, config, 'new.md', stage, { project: config.board.project })
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
  const stage = stageNamed(config, waiting?.stage ?? 'story')
  const artifacts = new Artifacts(board, unavailableWorkspaces, config, context.home).read(task, comments, context.cwd)
  const text = await session(context, settings, config, 'attach.md', stage, {
    issue: { id: task.id, title: task.title, body: task.body },
    stage: stage.name,
    request: request ? commentText(request) : '(no request found)',
    artifacts: Object.entries(artifacts)
      .map(([kind, content]) => `## Artifact: ${kind}\n\n${content.trim()}`)
      .join('\n\n'),
  })
  if (!text.ok) return fail(context, text.error)

  await board.addComment(id, `Answer from a live session:\n\n${text.value.trim()}`)
  context.stdout(`Posted the answer to task ${id}. The next conveyor cycle continues the ${stage.name} stage.\n`)
  return 0
}

export async function agentCommand(context: Context, id: string): Promise<number> {
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
  const stage = stageNamed(config, 'story')
  const text = await session(context, settings, config, 'task.md', stage, {
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
    context.stdout(`The session on task ${id} ended without a comment.\n`)
    return 0
  }
  await board.addComment(id, `Notes from a live session:\n\n${text.value.trim()}`)
  context.stdout(`Posted the notes of the session on task ${id}.\n`)
  return 0
}

async function session(
  context: Context,
  settings: string,
  config: Config,
  template: string,
  stage: Stage,
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

    const args =
      stage.harness === 'codex'
        ? [...(stage.model ? ['-m', stage.model] : []), '-c', `model_reasoning_effort="${stage.effort}"`, '--add-dir', dir, '--', prompt.text]
        : [...(stage.model ? ['--model', stage.model] : []), '--effort', stage.effort, '--add-dir', dir, '--', prompt.text]
    await context.interact(stage.harness, args, { cwd: context.cwd, env: { ...childEnv(process.env), CONVEYOR_RESULT: result } })

    if (!existsSync(result) || !readFileSync(result, 'utf8').trim()) return { ok: false, error: 'the session ended with no result' }
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

function stageNamed(config: Config, name: string): Stage {
  return config.stages.find((stage) => stage.name === name) ?? (config.stages[0] as Stage)
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
