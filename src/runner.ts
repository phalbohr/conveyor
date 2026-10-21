import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { taskRef, type Board } from './board/board.js'
import { probesOf, type Context } from './cli.js'
import { harnessesInUse, modelsFile } from './commands/models.js'
import { checkStages, cleanupWorkspaces, quotaFile, usageFile } from './commands/run.js'
import { loadConfig, type Config } from './config.js'
import { Engine, type Activity } from './engine/engine.js'
import { resetTask, type ResetEnd, type ResetForm } from './engine/reset.js'
import { sessionFile } from './session-log.js'
import { ClaudeHarness } from './harness/claude.js'
import { CodexHarness } from './harness/codex.js'
import { CommandHarness } from './harness/command.js'
import { acquireRunLock, runningPid } from './lock.js'
import { ModelCache, catalogsFor, modelKnown } from './models.js'
import { expandPath } from './paths.js'
import { checkSettingsSync, syncNotice } from './settings-sync.js'
import { undescribedNotice, undescribedStages } from './stage-catalog.js'
import { boardCheckLines, checkBoard, needsAttention } from './board-check.js'
import { redactSecrets } from './engine/redact.js'
import { QuotaStore, UsageLedger } from './usage.js'
import { GitWorkspaces, type Workspaces } from './workspaces.js'
import { MultiWorkspaces } from './multi-workspaces.js'
import { repoClones, repoProjects } from './repos.js'
import { stopLeftovers } from './engine/leftovers.js'

export type RunnerEvent = { time: string; level: 'info' | 'warning' | 'error'; text: string }
export type RunnerSetup = { settings: string; config: Config; board: Board; secrets: () => string[] }

const KEEP = 200
const LOG_LIMIT = 10 * 1024 * 1024

export function logFile(home: string, project: string) {
  return join(home, '.conveyor', 'logs', `${project.replaceAll('/', '-')}.log`)
}

export function taskWorkspaces(context: Context, settings: string, config: Config, board: Board): Workspaces {
  let hooks = config.hooks
  const root = expandPath(config.workspace.root, { home: context.home, project: config.board.project })
  const currentHooks = () => {
    const current = loadConfig(settings)
    if (current.ok) hooks = current.config.hooks
    return hooks
  }
  const repos = config.repos
  if (repos) {
    const clones = async () => repoClones({ repos, projects: await repoProjects(context.run, repos), paths: config.repo_paths, home: context.home, cwd: context.cwd })
    return new MultiWorkspaces({ root, clones, hooks: currentHooks })
  }
  return new GitWorkspaces({ repo: context.cwd, root, base: () => board.baseBranch(), hooks: currentHooks })
}

export class Runner {
  readonly events: RunnerEvent[] = []
  private readonly listeners = new Set<() => void>()
  private loop: Promise<void> | undefined
  private stopping = false
  private wake: () => void = () => undefined
  private again = false
  private draining = false
  private engine: Engine | undefined

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
    if (!modelKnown(catalogs[config.live.harness], config.live.model)) {
      this.emit('warning', `Live sessions use model ${config.live.model}, which ${config.live.harness} does not list. Check \`conveyor models ${config.live.harness}\`.`)
    }

    await checkBoard(board, config)
      .then((check) => {
        const lines = boardCheckLines(check)
        if (lines.length && !needsAttention(check)) this.emit('info', lines.join('\n'))
        else if (lines.length) this.emit('warning', `the board differs from what this version uses; nothing was changed. Run \`conveyor board update\` or press k on the control screen to add what is missing:\n${lines.join('\n')}`)
      })
      .catch((error: unknown) => this.emit('warning', `the board check failed: ${(error as Error).message}`))

    const project = config.board.project
    const lock = acquireRunLock(context.home, project)
    if (!lock.ok) {
      const error = `conveyor already runs for ${project} (pid ${lock.pid})`
      this.emit('error', error)
      return { ok: false, error }
    }

    const workspaces = taskWorkspaces(context, settings, config, board)
    const log = (text: string) => this.emit('info', text)
    const engine = (this.engine = new Engine({
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
      redact: (text) => redactSecrets(text, this.setup.secrets()),
      leftovers: (workspace, slug) => stopLeftovers(this.context.run, workspace, slug),
      wake: () => this.cycle(),
    }))

    let noticed = ''
    const checkSync = async () => {
      const sync = await checkSettingsSync(settings, { fetch: true, base: await board.baseBranch().catch(() => undefined) })
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
    this.draining = false
    this.loop = (async () => {
      try {
        await cleanupWorkspaces(board, workspaces, log)
        log(`conveyor runs for ${project}`)
        let interval = config.poll_interval
        while (!this.stopping) {
          this.again = false
          await checkSync().catch((error: unknown) => this.emit('warning', (error as Error).message))
          await engine.tick().catch((error: unknown) => this.emit('error', `cycle failed: ${(error as Error).message}`))
          const reloaded = loadConfig(settings)
          if (reloaded.ok) interval = reloaded.config.poll_interval
          if (this.again) continue
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, interval)
            this.wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
        }
        await engine.stop()
        log('stopped')
      } finally {
        lock.release()
        this.loop = undefined
        this.draining = false
        this.notify()
      }
    })()
    this.notify()
    return { ok: true }
  }

  get finishing() {
    return this.draining
  }

  drain() {
    if (!this.loop || this.stopping || this.draining || !this.engine) return
    this.draining = true
    const engine = this.engine
    const running = engine.drain()
    this.emit('info', `finishing: ${running.length ? `the stages of ${running.map((id) => `${taskRef(id)}`).join(', ')} run to their end` : 'no stage runs'}; no new stages or tasks start; the conveyor stops after them`)
    this.notify()
    void engine.idle().then(() => this.stop())
  }

  async stop() {
    if (!this.loop) return
    if (!this.stopping) {
      this.stopping = true
      const aborted = this.engine?.abort() ?? []
      this.emit('info', `stopping: ${aborted.length ? `aborting the stages of ${aborted.map((id) => `${taskRef(id)}`).join(', ')}` : 'no stage runs'}; the current cycle ends without new tasks, tasks resume on the next start`)
      this.wake()
    }
    await this.loop
  }

  activity(): Record<string, Activity> {
    return this.engine?.activity() ?? {}
  }

  cycle() {
    if (!this.loop || this.stopping) return false
    this.again = true
    this.wake()
    return true
  }

  async reset(id: string, form?: ResetForm, end: ResetEnd = 'backlog') {
    const { settings, config, board } = this.setup
    const pid = this.loop ? undefined : runningPid(this.context.home, config.board.project)
    if (pid) throw new Error(`the conveyor runs in another terminal (pid ${pid}); stop it there first, then reset ${taskRef(id)}`)
    const work = () => resetTask(board, taskWorkspaces(this.context, settings, config, board), id, form, sessionFile(this.context.home, config.board.project, id), config.parts, end)
    const summary = await (this.loop && this.engine ? this.engine.hold(id, work) : work())
    this.emit('info', `task ${id}: ${summary}`)
    return summary
  }

  note(text: string) {
    this.emit('info', text)
  }

  private emit(level: RunnerEvent['level'], text: string) {
    const event = { time: new Date().toISOString(), level, text: redactSecrets(text, this.setup.secrets()) }
    this.events.push(event)
    if (this.events.length > KEEP) this.events.splice(0, this.events.length - KEEP)
    const file = logFile(this.context.home, this.setup.config.board.project)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > LOG_LIMIT) renameSync(file, `${file}.1`)
    appendFileSync(file, `${event.time} ${level} ${event.text}\n`, { mode: 0o600 })
    this.echo?.(event)
    this.notify()
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }
}
