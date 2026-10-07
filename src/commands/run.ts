import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Board } from '../board/board.js'
import { Runner } from '../runner.js'
import { hub } from './hub.js'
import { GitHubBoard } from '../board/github.js'
import { GitLabBoard } from '../board/gitlab.js'
import { RedactingBoard } from '../board/redacting.js'
import { type Context } from '../cli.js'
import { loadConfig, type Config } from '../config.js'
import { configSecrets, secretValues } from '../engine/redact.js'
import { manualRelease } from '../engine/release.js'
import { parseStageFile } from '../engine/stage-file.js'
import { findSettings } from '../settings.js'
import { resolveSkills } from '../skills.js'
import { type Workspaces } from '../workspaces.js'

type Prepared = { settings: string; config: Config; board: Board; secrets: () => string[] }

export function checkStages(config: Config, settings: string, context: { repo: string; home: string }): string[] {
  const problems: string[] = []
  for (const stage of config.stages) {
    const path = join(settings, 'stages', `${stage.name}.md`)
    const file = parseStageFile(existsSync(path) ? readFileSync(path, 'utf8') : '')
    if (!file.ok) {
      problems.push(`stages/${stage.name}.md: ${file.error}`)
      continue
    }
    if (file.skills.length === 0) continue
    if (stage.harness !== 'claude') {
      problems.push(`${stage.name}: skills are supported only with the claude harness`)
      continue
    }
    const { missing } = resolveSkills(file.skills, context)
    if (missing.length > 0) problems.push(`${stage.name}: skills not found: ${missing.join(', ')}`)
  }
  return problems
}

export async function cleanupWorkspaces(board: Board, workspaces: Workspaces, log: (message: string) => void) {
  for (const id of await workspaces.list()) {
    const task = await board.getTask(id)
    if (task && !task.closed) continue
    await workspaces.remove(id)
    log(`removed the workspace of closed task ${id}`)
  }
}

export async function runCommand(context: Context, options: { once?: boolean }): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  if (context.interactive && !options.once) return hub(context, prepared, { start: true })

  const runner = new Runner(context, prepared, (event) => {
    if (event.level === 'info') context.stdout(`${event.time} ${event.text}\n`)
    else context.stderr(event.level === 'warning' ? `warning: ${event.text}\n` : `${event.text}\n`)
  })
  const started = await runner.start({ ...(options.once ? { once: true } : {}) })
  if (!started.ok) return 1
  if (options.once) return 0
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await runner.stop()
  return 0
}

export async function releaseCommand(context: Context, id: string, force: boolean): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const result = await manualRelease(prepared.board, id, force)
  if (!result.ok) {
    context.stderr(`${result.error}\n`)
    return 1
  }
  context.stdout(`Released task ${id}.\n`)
  return 0
}

export function prepare(context: Context): Prepared | undefined {
  const settings = findSettings(context.cwd, context.home)
  if (!settings) {
    context.stderr(`No conveyor settings found in ${context.cwd}. Run \`conveyor init\`.\n`)
    return undefined
  }
  const loaded = loadConfig(settings)
  if (!loaded.ok) {
    context.stderr(`${loaded.errors.join('\n')}\n`)
    return undefined
  }
  const { provider, project, github_project } = loaded.config.board
  const warn = (message: string) => context.stderr(`warning: ${message}\n`)
  const secrets = () => {
    const current = loadConfig(settings)
    return [...secretValues(process.env), ...configSecrets(current.ok ? current.config : loaded.config)]
  }
  const board = new RedactingBoard(
    context.boardFor?.(loaded.config) ??
      (provider === 'gitlab'
        ? new GitLabBoard(project, context.run)
        : new GitHubBoard(project, context.run, { ...(github_project ? { projectNumber: github_project } : {}), warn })),
    secrets,
  )
  return { settings, config: loaded.config, board, secrets }
}

export function usageFile(home: string, project: string) {
  return join(home, '.conveyor', 'usage', `${project.replaceAll('/', '-')}.json`)
}

export function quotaFile(home: string, project: string) {
  return join(home, '.conveyor', 'usage', `${project.replaceAll('/', '-')}.quota.json`)
}
