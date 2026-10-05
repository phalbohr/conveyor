import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Board } from '../board/board.js'
import { GitHubBoard } from '../board/github.js'
import { GitLabBoard } from '../board/gitlab.js'
import type { Context } from '../cli.js'
import { loadConfig, type Config, type LoadResult } from '../config.js'
import { Engine } from '../engine/engine.js'
import { manualRelease } from '../engine/release.js'
import { parseStageFile } from '../engine/stage-file.js'
import { ClaudeHarness } from '../harness/claude.js'
import { CodexHarness } from '../harness/codex.js'
import { CommandHarness } from '../harness/command.js'
import { acquireRunLock } from '../lock.js'
import { expandPath } from '../paths.js'
import { findSettings } from '../settings.js'
import { resolveSkills } from '../skills.js'
import { QuotaStore, UsageLedger } from '../usage.js'
import { GitWorkspaces, type Workspaces } from '../workspaces.js'

type Prepared = { settings: string; config: Config; board: Board }

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
  const { settings, config } = prepared
  const problems = checkStages(config, settings, { repo: context.cwd, home: context.home })
  if (problems.length > 0) {
    context.stderr(`${problems.join('\n')}\n`)
    return 1
  }

  const lock = acquireRunLock(context.home, config.board.project)
  if (!lock.ok) {
    context.stderr(`conveyor already runs for ${config.board.project} (pid ${lock.pid})\n`)
    return 1
  }

  const log = (message: string) => context.stdout(`${new Date().toISOString()} ${message}\n`)
  try {
    const project = config.board.project
    let hooks = config.hooks
    const workspaces = new GitWorkspaces({
      repo: context.cwd,
      root: expandPath(config.workspace.root, { home: context.home, project }),
      hooks: () => {
        const current = loadConfig(settings)
        if (current.ok) hooks = current.config.hooks
        return hooks
      },
    })
    await cleanupWorkspaces(prepared.board, workspaces, log)
    const engine = new Engine({
      board: prepared.board,
      harnesses: {
        claude: new ClaudeHarness(),
        codex: new CodexHarness(),
        ...Object.fromEntries(Object.entries(config.harnesses).map(([harnessName, definition]) => [harnessName, new CommandHarness(definition)])),
      },
      workspaces,
      settingsDir: settings,
      repo: context.cwd,
      home: context.home,
      usage: new UsageLedger(usageFile(context.home, project)),
      quotas: new QuotaStore(quotaFile(context.home, project)),
      loadConfig: () => loadConfig(settings),
      log,
    })

    if (options.once) {
      await engine.tick()
      await engine.idle()
      return 0
    }

    let stopping = false
    let wake = () => undefined as void
    const stop = () => {
      stopping = true
      wake()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    log(`conveyor runs for ${project}`)
    let interval = config.poll_interval
    while (!stopping) {
      await engine.tick()
      const reloaded: LoadResult = loadConfig(settings)
      if (reloaded.ok) interval = reloaded.config.poll_interval
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    log('stopping: running stages are aborted, tasks resume on the next start')
    await engine.stop()
    return 0
  } finally {
    lock.release()
  }
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
  const board =
    context.boardFor?.(loaded.config) ??
    (provider === 'gitlab'
      ? new GitLabBoard(project, context.run)
      : new GitHubBoard(project, context.run, { ...(github_project ? { projectNumber: github_project } : {}), warn }))
  return { settings, config: loaded.config, board }
}

export function usageFile(home: string, project: string) {
  return join(home, '.conveyor', 'usage', `${project.replaceAll('/', '-')}.json`)
}

export function quotaFile(home: string, project: string) {
  return join(home, '.conveyor', 'usage', `${project.replaceAll('/', '-')}.quota.json`)
}
