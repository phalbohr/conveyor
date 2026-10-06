import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Board } from './board/board.js'
import { probesOf, type Context } from './cli.js'
import { harnessesInUse, modelsFile } from './commands/models.js'
import { checkStages, cleanupWorkspaces, quotaFile, usageFile } from './commands/run.js'
import { loadConfig, type Config } from './config.js'
import { Engine } from './engine/engine.js'
import { ClaudeHarness } from './harness/claude.js'
import { CodexHarness } from './harness/codex.js'
import { CommandHarness } from './harness/command.js'
import { acquireRunLock } from './lock.js'
import { ModelCache, catalogsFor, modelKnown } from './models.js'
import { expandPath } from './paths.js'
import { checkSettingsSync, syncNotice } from './settings-sync.js'
import { undescribedNotice, undescribedStages } from './stage-catalog.js'
import { QuotaStore, UsageLedger } from './usage.js'
import { GitWorkspaces } from './workspaces.js'

export type RunnerEvent = { time: string; level: 'info' | 'warning' | 'error'; text: string }
export type RunnerSetup = { settings: string; config: Config; board: Board }

const KEEP = 200

export function logFile(home: string, project: string) {
  return join(home, '.conveyor', 'logs', `${project.replaceAll('/', '-')}.log`)
}

export class Runner {
  readonly events: RunnerEvent[] = []
  private readonly listeners = new Set<() => void>()
  private loop: Promise<void> | undefined
  private stopping = false
  private wake: () => void = () => undefined

  constructor(
    private readonly context: Context,
    private readonly setup: RunnerSetup,
    private readonly echo?: (event: RunnerEvent) => void,
  ) {}

  get running() {
    return this.loop !== undefined
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(options: { once?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.loop) return { ok: false, error: 'the conveyor already runs here' }
    const { settings, config, board } = this.setup
    const { context } = this
    const problems = checkStages(config, settings, { repo: context.cwd, home: context.home })
    if (problems.length > 0) {
      for (const problem of problems) this.emit('error', problem)
      return { ok: false, error: problems.join('\n') }
    }
    for (const notice of undescribedNotice(undescribedStages(settings, config))) this.emit('warning', notice)
    const catalogs = await catalogsFor(harnessesInUse(config), config, probesOf(context), new ModelCache(modelsFile(context.home, config.board.project)), false)
    for (const stage of [...config.stages, { name: 'triage', ...config.triage }]) {
      if (!modelKnown(catalogs[stage.harness], stage.model)) {
        this.emit('warning', `Stage ${stage.name} uses model ${stage.model}, which ${stage.harness} does not list. Check \`conveyor models ${stage.harness}\`.`)
      }
    }

    const project = config.board.project
    const lock = acquireRunLock(context.home, project)
    if (!lock.ok) {
      const error = `conveyor already runs for ${project} (pid ${lock.pid})`
      this.emit('error', error)
      return { ok: false, error }
    }

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
    const log = (text: string) => this.emit('info', text)
    const engine = new Engine({
      board,
      harnesses: {
        claude: new ClaudeHarness(),
        codex: new CodexHarness(),
        ...Object.fromEntries(Object.entries(config.harnesses).map(([name, definition]) => [name, new CommandHarness(definition)])),
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

    let noticed = ''
    const checkSync = async () => {
      const sync = await checkSettingsSync(settings, { fetch: true })
      if (sync.state !== 'behind' || sync.commits.join() === noticed) return
      noticed = sync.commits.join()
      this.emit('warning', syncNotice(sync))
    }

    if (options.once) {
      try {
        await cleanupWorkspaces(board, workspaces, log)
        await checkSync()
        await engine.tick()
        await engine.idle()
      } finally {
        lock.release()
      }
      return { ok: true }
    }

    this.stopping = false
    this.loop = (async () => {
      try {
        await cleanupWorkspaces(board, workspaces, log)
        log(`conveyor runs for ${project}`)
        let interval = config.poll_interval
        while (!this.stopping) {
          await checkSync().catch((error: unknown) => this.emit('warning', (error as Error).message))
          await engine.tick().catch((error: unknown) => this.emit('error', `cycle failed: ${(error as Error).message}`))
          const reloaded = loadConfig(settings)
          if (reloaded.ok) interval = reloaded.config.poll_interval
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, interval)
            this.wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
        }
        log('stopping: running stages are aborted, tasks resume on the next start')
        await engine.stop()
        log('stopped')
      } finally {
        lock.release()
        this.loop = undefined
        this.notify()
      }
    })()
    this.notify()
    return { ok: true }
  }

  async stop() {
    if (!this.loop) return
    this.stopping = true
    this.wake()
    await this.loop
  }

  private emit(level: RunnerEvent['level'], text: string) {
    const event = { time: new Date().toISOString(), level, text }
    this.events.push(event)
    if (this.events.length > KEEP) this.events.splice(0, this.events.length - KEEP)
    const file = logFile(this.context.home, this.setup.config.board.project)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${event.time} ${level} ${text}\n`)
    this.echo?.(event)
    this.notify()
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }
}
