import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { join } from 'node:path'
import type { Board, Comment, PullRequest, Task } from '../board/board.js'
import type { Config, Harness as HarnessName, LoadResult, Stage } from '../config.js'
import type { Harness, Quota, QuotaWindow, StageOutput, StageResult } from '../harness/harness.js'
import { NO_USAGE, failed } from '../harness/harness.js'
import { isModelError } from '../models.js'
import { resolveSkills } from '../skills.js'
import { QuotaStore, type UsageLedger } from '../usage.js'
import type { Workspaces } from '../workspaces.js'
import { Artifacts } from './artifacts.js'
import { buildPrompt, buildTriagePrompt, type GateMode } from './prompt.js'
import { releaseClaim } from './release.js'
import { publicText } from './redact.js'
import { Trust } from './trust.js'
import { parseStageFile, readFormat, renderInstructions } from './stage-file.js'
import { waitingDeadline } from './time.js'
import {
  agentComment,
  commentText,
  findWorkpad,
  isAgentComment,
  renderWorkpad,
  repliesSince,
  type Workpad,
  type WorkpadState,
} from './workpad.js'

export type EngineOptions = {
  board: Board
  harnesses: Partial<Record<HarnessName, Harness>>
  workspaces: Workspaces
  settingsDir: string
  repo: string
  home: string
  usage: UsageLedger
  quotas?: QuotaStore
  loadConfig: () => LoadResult
  log?: (message: string) => void
}

type Running = { controller: AbortController; promise: Promise<void> }

type StageAttempt = StageOutput & { fatal?: boolean }

type Verdict = {
  kind: 'merged' | 'rework' | 'fix' | 'merge' | 'invalid' | 'wait'
  pull: PullRequest | undefined
  approvers: string[]
  feedback: string[]
  from?: string
  error?: string
}

const FIX_FROM = /^\/fix_from:?\s+([a-z][a-z0-9-]*)/i

type TaskRun = {
  id: string
  config: Config
  signal: AbortSignal
  state: WorkpadState
  text: string
  padId: string | undefined
  workspace: string
  artifacts: Artifacts
  save: () => Promise<void>
}

const TRIAGE_LOCK = 'triage'
const DEFAULT_PRIORITY = 3
const NEW_STATES: Task['state'][] = ['idea', 'story', 'plan']
const triageSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      priority: z.int().min(1).max(4).optional(),
      blocked_by: z.array(z.union([z.string(), z.number()]).transform(String)).default([]),
    }),
  ),
})

const QUOTA_FRESH = 10 * 60_000
const LAND = 'land'
const LAND_WAIT = 60_000
const MERGE_LOCK = 'merge'
const LOCK_TTL = 10 * 60_000

type StageContext = {
  workspace: string
  artifacts: Record<string, string>
  workpad: string
  gate: { mode: GateMode; criteria: string } | undefined
  conversation: { request: string; replies: string[]; approval: boolean } | undefined
  attempt: number
  signal: AbortSignal
  review?: string | undefined
  reviewMode?: 'fix' | 'rework' | undefined
  merge?: string | undefined
}

const PICKUP: Record<Config['pickup_from'], Task['state'][]> = {
  idea: ['idea', 'story', 'plan'],
  story: ['story', 'plan'],
  plan: ['plan'],
}

const GATES: Record<string, { transition: 'idea_to_story' | 'story_to_plan'; criteria: string }> = {
  story: { transition: 'idea_to_story', criteria: 'idea-story' },
  plan: { transition: 'story_to_plan', criteria: 'story-plan' },
}

const WAITING_STATES: Task['state'][] = ['needs-input', 'queued', 'review']

export class Engine {
  private readonly running = new Map<string, Running>()
  private readonly cleanups = new Set<Promise<void>>()
  private me?: string
  private triageRetryAt = 0
  private readonly heldLocks = new Map<string, { first: number; last: number }>()
  private readonly untrusted = new Set<string>()

  private readonly quotas: QuotaStore
  private readonly trust: Trust

  constructor(private readonly options: EngineOptions) {
    this.quotas = options.quotas ?? new QuotaStore()
    this.trust = new Trust(options.board)
  }

  async tick() {
    const { board } = this.options
    const me = (this.me ??= await board.user())
    await this.reconcile(me)

    const loaded = this.options.loadConfig()
    if (!loaded.ok) {
      this.log(`configuration is invalid, no new tasks are claimed:\n${loaded.errors.join('\n')}`)
      return
    }
    const config = loaded.config
    await this.probeQuotas(config)
    await this.triage(config).catch((error: unknown) => this.log(`triage failed: ${(error as Error).message}`))

    const resumable: Task[] = []
    const fresh: Task[] = []
    let awaitingMe = 0
    let awaitingReview = 0
    const now = Date.now()

    for (const listed of await board.listTasks()) {
      if (this.running.has(listed.id)) continue
      if (!(await this.trust.trusted(listed.author))) {
        if (!this.untrusted.has(listed.id)) this.log(`task ${listed.id}: skipped: its author @${listed.author} has no write access to the repository`)
        this.untrusted.add(listed.id)
        continue
      }
      const task = (await this.releaseIfExpired(listed, me, config, now)) ? withoutOwner(listed) : listed
      if (task.owner && task.owner !== me) continue
      const owned = task.owner === me
      switch (task.state) {
        case 'review': {
          const verdict = await this.reviewSignal(task.id, config)
          if (verdict.kind === 'invalid') await this.rejectCommand(task.id, verdict.error ?? 'Invalid command.')
          if (verdict.kind !== 'wait' && verdict.kind !== 'invalid') (owned ? resumable : fresh).push(task)
          else if (owned) awaitingReview++
          break
        }
        case 'rework':
          ;(owned ? resumable : fresh).push(task)
          break
        case 'needs-input': {
          const answered = await this.answered(task.id)
          if (answered) (owned ? resumable : fresh).push(task)
          else if (owned) awaitingMe++
          break
        }
        case 'in-progress':
        case 'queued': {
          if (!owned) fresh.push(task)
          else if (await this.retryDue(task.id, now)) resumable.push(task)
          break
        }
        case 'idea':
        case 'story':
        case 'plan':
          if (owned) resumable.push(task)
          else if (PICKUP[config.pickup_from].includes(task.state) && task.openBlockers === 0 && this.pickable(task, config, me)) {
            fresh.push(task)
          }
          break
      }
    }

    let slots = config.limits.running - this.running.size
    let waiting = 0
    for (const task of this.sorted(resumable, me)) {
      if (slots > 0) {
        this.start(task, config)
        slots--
        continue
      }
      waiting++
      if (task.state === 'needs-input') await board.setState(task.id, 'queued')
    }

    const overBudget =
      (config.limits.daily_tokens > 0 && this.options.usage.today() >= config.limits.daily_tokens) ||
      config.stages.some((stage) => this.quotaBlock(stage.harness, config) !== undefined)
    if (waiting > 0 || overBudget || awaitingMe >= config.limits.awaiting_me || awaitingReview >= config.limits.awaiting_review) return

    for (const task of this.sorted(fresh, me)) {
      if (slots <= 0) break
      if (!(await this.lock(task.id, LOCK_TTL))) continue
      await board.setOwner(task.id, me)
      this.log(`claimed task ${task.id}: ${task.title}`)
      this.start(task, config)
      slots--
    }
  }

  async idle() {
    while (this.running.size > 0 || this.cleanups.size > 0) {
      await Promise.all([...[...this.running.values()].map((running) => running.promise), ...this.cleanups])
    }
  }

  async stop() {
    for (const running of this.running.values()) running.controller.abort()
    await this.idle()
  }

  async release(id: string, reason: string) {
    const running = this.running.get(id)
    running?.controller.abort()
    await running?.promise
    await releaseClaim(this.options.board, id, reason)
    this.log(`task ${id}: ${reason}`)
  }

  private async reconcile(me: string) {
    for (const [id, running] of this.running) {
      let task: Task | undefined
      try {
        task = await this.options.board.getTask(id)
      } catch (error) {
        this.log(`task ${id}: reconciliation skipped: ${(error as Error).message}`)
        continue
      }
      if (!task || task.closed) {
        running.controller.abort()
        const cleanup = running.promise
          .then(() => this.options.workspaces.remove(id))
          .catch((error: unknown) => this.log(`task ${id}: ${(error as Error).message}`))
          .finally(() => this.cleanups.delete(cleanup))
        this.cleanups.add(cleanup)
      } else if (!task.state || task.owner !== me) {
        running.controller.abort()
      }
    }
  }

  private async releaseIfExpired(task: Task, me: string, config: Config, now: number) {
    if (!task.owner || !task.state) return false
    const waiting = WAITING_STATES.includes(task.state)
    if (!waiting && (task.state !== 'in-progress' || task.owner === me)) return false
    const { pad } = await this.workpad(task.id)
    if (!pad || pad.state.private) return false

    if (waiting) {
      const since = pad.state.waiting?.since
      if (!since || now < waitingDeadline(new Date(since), config.timeouts.waiting).getTime()) return false
      await this.release(task.id, `Released the claim of @${task.owner}: the task waited longer than the waiting timeout.`)
      return true
    }
    const heartbeat = pad.state.heartbeat
    if (heartbeat && now - Date.parse(heartbeat) <= config.timeouts.heartbeat) return false
    await this.release(task.id, `Released the claim of @${task.owner}: no heartbeat for longer than the heartbeat timeout.`)
    return true
  }

  private start(task: Task, config: Config) {
    const controller = new AbortController()
    const promise = this.execute(task, config, controller.signal)
      .catch((error: unknown) => this.log(`task ${task.id}: ${(error as Error).message}`))
      .finally(() => this.running.delete(task.id))
    this.running.set(task.id, { controller, promise })
  }

  private async execute(initial: Task, config: Config, signal: AbortSignal) {
    const { board, workspaces } = this.options
    const id = initial.id
    const comments = await this.comments(id)
    const pad = findWorkpad(comments)
    const state: WorkpadState = { attempt: 0, ...pad?.state }
    const verdict = initial.state === 'review' ? await this.reviewSignal(id, config) : undefined
    const pull = verdict?.pull
    const rework = initial.state === 'rework' || verdict?.kind === 'rework'
    const waiting = state.waiting
    const approvalStage = waiting?.kind === 'approval' ? waiting.stage : undefined
    const conversation = waiting && waiting.kind !== 'review' ? this.conversation(comments, waiting) : undefined
    if (waiting?.kind === 'error' && waiting.stage === LAND) state.landAttempts = 0
    delete state.waiting
    delete state.retryAt
    state.private = Object.values(config.artifacts).some((artifact) => artifact.store === 'path')

    const run: TaskRun = {
      id,
      config,
      signal,
      state,
      text: pad?.text ?? '',
      padId: pad?.id,
      workspace: '',
      artifacts: new Artifacts(board, workspaces, config, this.options.home),
      save: async () => {
        state.heartbeat = new Date().toISOString()
        const body = renderWorkpad(state, run.text)
        if (run.padId) await board.updateComment(run.padId, body)
        else run.padId = (await board.addComment(id, body)).id
      },
    }

    await board.setState(id, 'in-progress')
    await run.save()
    run.workspace = (await workspaces.prepare(id)).path

    const names = config.stages.map((stage) => stage.name)
    const mergeIndex = names.indexOf('merge')
    if (rework || verdict?.kind === 'fix') {
      const since = waiting?.kind === 'review' ? waiting.since : ''
      const feedback =
        verdict?.feedback ??
        comments.filter((comment) => !isAgentComment(comment) && comment.createdAt >= since).map((comment) => comment.body)
      for (const key of ['landing', 'mergeError', 'landAttempts', 'lastError'] as const) delete state[key]
      state.attempt = 0
      state.review = feedback.join('\n\n') || 'The reviewer asked for changes. Read the issue comments for details.'
      if (rework) {
        if (pull?.state === 'open') await board.closePullRequest(id)
        await workspaces.reset(id)
        run.text = ''
        state.reviewMode = 'rework'
        state.stage = names[names.indexOf('plan') + 1] ?? 'merge'
      } else {
        state.reviewMode = 'fix'
        state.stage = verdict?.from ?? 'plan'
      }
      this.log(`task ${id}: ${state.reviewMode} from ${state.stage}`)
    } else if (verdict?.kind === 'merged') {
      state.landing = 'success'
      delete state.stage
    } else if (verdict?.kind === 'merge') {
      state.stage = LAND
      this.log(`task ${id}: approved by ${verdict.approvers.join(', ')}`)
    }

    if (!state.landing && state.stage !== LAND) {
      const start = state.stage ?? (initial.state === 'idea' ? 'story' : initial.state === 'story' ? 'plan' : names[names.indexOf('plan') + 1])
      const chain = await this.runChain(run, config.stages.slice(names.indexOf(start ?? 'merge'), mergeIndex + 1), {
        approvalStage,
        conversation,
      })
      if (chain.status !== 'done') return
      delete state.review
      delete state.reviewMode
      const task = (await board.getTask(id)) ?? initial
      await board.openPullRequest(id, task.title, `Conveyor task #${id}.\n\n${chain.summary}`)
      if (chain.merge === 'review') {
        delete state.stage
        state.waiting = { kind: 'review', since: new Date().toISOString() }
        await board.setState(id, 'review')
        await run.save()
        return
      }
      state.stage = LAND
    }

    if (state.stage === LAND) {
      const landed = await this.land(run)
      if (landed === 'stop') return
      state.landing = landed
      delete state.stage
    }

    const landing = state.landing ?? 'success'
    const post = config.stages.slice(mergeIndex + 1).filter((stage) => stage.when === 'always' || stage.when === landing)
    const resumeAt = state.stage ? post.findIndex((stage) => stage.name === state.stage) : 0
    const merge =
      landing === 'success'
        ? 'The pull request is merged.'
        : `The merge failed: ${state.mergeError ?? 'unknown error'}. Fix the cause on the task branch. The conveyor commits and pushes your changes and tries to merge again.`
    const chain = await this.runChain(run, post.slice(Math.max(resumeAt, 0)), { merge })
    if (chain.status !== 'done') return

    if (landing === 'failure') {
      delete state.landing
      state.stage = LAND
      await run.save()
      return
    }

    for (const key of ['stage', 'landing', 'mergeError', 'landAttempts', 'review', 'lastError'] as const) delete state[key]
    state.attempt = 0
    await board.setState(id, 'done')
    await run.save()
    await board.closeTask(id)
    await board.release(id)
    await workspaces.remove(id)
    await workspaces.deleteBranch(id)
    this.log(`task ${id}: done`)
  }

  private async runChain(
    run: TaskRun,
    stages: Stage[],
    options: { approvalStage?: string | undefined; conversation?: StageContext['conversation']; merge?: string },
  ): Promise<{ status: 'done' | 'stopped'; merge?: 'land' | 'review'; summary: string }> {
    const { board, workspaces } = this.options
    const { id, config, signal, state } = run
    let conversation = options.conversation
    let summary = ''
    let merge: 'land' | 'review' | undefined

    for (const stage of stages) {
      if (signal.aborted) return { status: 'stopped', summary }
      state.stage = stage.name
      const blockedUntil = this.quotaBlock(stage.harness, config)
      if (blockedUntil) {
        state.retryAt = blockedUntil
        await run.save()
        this.log(`task ${id}: stage ${stage.name} waits for the ${stage.harness} subscription window until ${blockedUntil}`)
        return { status: 'stopped', summary }
      }
      await run.save()
      const task = (await board.getTask(id)) ?? (await this.mustGetTask(id))
      const comments = await this.comments(id)
      const gate = this.gate(stage, config)
      const heartbeat = setInterval(() => void run.save().catch(() => undefined), config.timeouts.heartbeat / 3)
      let output: StageAttempt
      try {
        output = await this.runStage(task, stage, config, {
          workspace: run.workspace,
          artifacts: run.artifacts.read(task, comments, run.workspace),
          workpad: run.text,
          gate,
          conversation,
          attempt: state.attempt,
          signal,
          review: state.review,
          reviewMode: state.reviewMode,
          merge: options.merge,
        })
      } finally {
        clearInterval(heartbeat)
      }
      if (signal.aborted) return { status: 'stopped', summary }
      this.options.usage.add(output.usage.inputTokens + output.usage.outputTokens)
      if (output.quota) this.quotas.set(stage.harness, output.quota)
      this.log(`task ${id}: stage ${stage.name} → ${output.result.outcome}: ${output.result.summary}`)
      conversation = undefined
      await workspaces
        .commitAll(id, `${stage.name}: ${(output.result.summary.split('\n')[0] ?? '').slice(0, 72)}`)
        .catch((error: unknown) => this.log(`task ${id}: commit failed: ${(error as Error).message}`))
      await workspaces.push(id).catch((error: unknown) => this.log(`task ${id}: push failed: ${(error as Error).message}`))

      let result = output.result
      if (result.workpad) run.text = result.workpad
      if (stage.name === 'merge' && (result.outcome === 'done' || result.outcome === 'approval')) {
        const mode = config.transitions.merge
        merge = mode === 'human' || (mode === 'smart' && result.outcome === 'approval') ? 'review' : 'land'
        result = { ...result, outcome: 'done' }
      }
      if (result.outcome === 'done' && gate?.mode === 'interactive' && options.approvalStage !== stage.name) result = { ...result, outcome: 'approval' }
      if (result.outcome === 'approval' && gate?.mode === 'autonomous') result = { ...result, outcome: 'done' }
      if (result.artifact && result.outcome !== 'failed') {
        const kind = GATES[stage.name] || ['idea', 'story'].includes(result.artifact.kind) ? stage.name : result.artifact.kind
        await run.artifacts.store(task, kind, result.artifact.content, comments)
      }

      if (result.outcome === 'done') {
        state.attempt = 0
        delete state.lastError
        summary = result.summary
        continue
      }
      if (result.outcome === 'failed') {
        const modelError = isModelError(result.summary)
        if (modelError) {
          result = {
            ...result,
            summary: `The ${stage.harness} harness does not know the model \`${stage.model}\`. Change \`stages.${stage.name}.model\`; \`conveyor models ${stage.harness}\` lists the models.\n\n${result.summary}`,
          }
        }
        await this.fail(id, stage, state, result, config, (output.fatal ?? false) || modelError)
        await run.save()
        return { status: 'stopped', summary }
      }
      const kind = result.outcome === 'approval' ? 'approval' : 'questions'
      const comment = await board.addComment(id, agentComment(kind, this.request(stage.name, result)))
      state.attempt = 0
      delete state.lastError
      state.waiting = { kind, stage: stage.name, commentId: comment.id, since: new Date().toISOString() }
      await board.setState(id, 'needs-input')
      await run.save()
      return { status: 'stopped', summary }
    }
    return { status: 'done', ...(merge ? { merge } : {}), summary }
  }

  private async land(run: TaskRun): Promise<'success' | 'failure' | 'stop'> {
    const { board } = this.options
    const { id, config, state } = run
    const wait = async (reason: string) => {
      state.stage = LAND
      state.retryAt = new Date(Date.now() + LAND_WAIT).toISOString()
      await run.save()
      this.log(`task ${id}: merge waits: ${reason}`)
      return 'stop' as const
    }

    const task = await this.mustGetTask(id)
    if (task.openBlockers > 0) return wait('open blockers')
    const pull = await board.pullRequest(id)
    if (pull?.state === 'merged') return 'success'
    let error: string | undefined
    if (!pull || pull.state === 'closed') error = 'the pull request is closed'
    else if (pull.checks === 'pending' || pull.mergeable === 'unknown') return wait('checks are pending')
    else if (pull.checks === 'failure') error = 'checks failed'
    else if (pull.mergeable === 'no') error = 'the branch has conflicts with the base branch'
    else {
      if (!(await this.lock(MERGE_LOCK, LOCK_TTL))) return wait('another workstation merges')
      try {
        const merged = await board.mergePullRequest(id, config.merge_method, pull.headSha)
        if (!merged.ok) error = merged.error
      } finally {
        await board.release(MERGE_LOCK)
      }
    }
    if (!error) {
      delete state.mergeError
      return 'success'
    }
    error = publicText(error, this.options.home)

    state.mergeError = error
    state.landAttempts = (state.landAttempts ?? 0) + 1
    const names = config.stages.map((stage) => stage.name)
    const repair = config.stages.slice(names.indexOf('merge') + 1).some((stage) => stage.when === 'failure' || stage.when === 'always')
    this.log(`task ${id}: merge failed: ${error}`)
    if (repair && state.landAttempts < config.retry.max_attempts) return 'failure'

    const text = `**The merge failed.**\n\n${error}\n\nFix the cause, then reply in a comment to retry.`
    const comment = await board.addComment(id, agentComment('error', text))
    state.stage = LAND
    state.waiting = { kind: 'error', stage: LAND, commentId: comment.id, since: new Date().toISOString() }
    await board.setState(id, 'needs-input')
    await run.save()
    return 'stop'
  }

  private quotaBlock(harness: HarnessName, config: Config): string | undefined {
    const known = this.quotas.get(harness)?.quota
    if (!known) return undefined
    const { five_hour_reserve, seven_day_reserve } = config.limits.subscription
    const checks: [QuotaWindow | undefined, number][] = [
      [known.fiveHour, five_hour_reserve],
      [known.sevenDay, seven_day_reserve],
    ]
    const blocked = checks
      .filter(([window, reserve]) => window && reserve > 0 && Date.parse(window.resetsAt) > Date.now() && window.utilization * 100 >= 100 - reserve)
      .map(([window]) => (window as QuotaWindow).resetsAt)
      .sort()
    return blocked.at(-1)
  }

  private async probeQuotas(config: Config) {
    const { probe, five_hour_reserve, seven_day_reserve } = config.limits.subscription
    if (!probe || (five_hour_reserve === 0 && seven_day_reserve === 0)) return
    const names = new Set([config.triage.harness, ...config.stages.map((stage) => stage.harness)])
    for (const name of names) {
      const harness = this.options.harnesses[name]
      const observed = this.quotas.get(name)?.observedAt ?? 0
      if (!harness?.probeQuota || Date.now() - observed < QUOTA_FRESH) continue
      const quota = await harness.probeQuota(this.options.repo).catch(() => undefined)
      if (quota) this.quotas.set(name, quota)
    }
  }

  private async triage(config: Config) {
    const { board } = this.options
    if (Date.now() < this.triageRetryAt) return
    if (config.limits.daily_tokens > 0 && this.options.usage.today() >= config.limits.daily_tokens) return
    if (this.quotaBlock(config.triage.harness, config)) return
    const tasks = await this.trust.only(await board.listTasks())
    const fresh = tasks.filter((task) => !task.owner && NEW_STATES.includes(task.state) && task.priority === undefined).map((task) => task.id)
    if (fresh.length === 0) return
    const harness = this.options.harnesses[config.triage.harness]
    if (!harness) {
      this.log(`triage skipped: harness ${config.triage.harness} is not available`)
      return
    }
    if (!(await this.lock(TRIAGE_LOCK, config.timeouts.stage + LOCK_TTL))) return
    const cwd = mkdtempSync(join(tmpdir(), 'conveyor-triage-'))
    try {
      const output = await harness.runStage({
        stage: 'triage',
        prompt: buildTriagePrompt({ instructions: this.read('triage.md'), tasks, fresh, language: config.language.docs }),
        model: config.triage.model,
        effort: config.triage.effort,
        cwd,
        signal: AbortSignal.timeout(config.timeouts.stage),
      })
      this.options.usage.add(output.usage.inputTokens + output.usage.outputTokens)
      const parsed = output.result.outcome === 'done' && output.result.artifact ? parseJson(output.result.artifact.content) : undefined
      const result = triageSchema.safeParse(parsed)
      if (!result.success) {
        this.triageRetryAt = Date.now() + config.retry.max_backoff
        this.log(`triage failed: ${output.result.outcome === 'done' ? 'invalid triage result' : output.result.summary}`)
        return
      }
      const known = new Set(tasks.map((task) => task.id))
      const prioritized = new Set<string>()
      for (const entry of result.data.tasks) {
        if (!known.has(entry.id)) continue
        if (entry.priority !== undefined) {
          await board.setPriority(entry.id, entry.priority)
          prioritized.add(entry.id)
        }
        for (const blocker of entry.blocked_by) {
          if (blocker === entry.id || !known.has(blocker)) continue
          await board.addBlocker(entry.id, blocker).catch((error: unknown) => this.log(`triage: blocker ${blocker} → ${entry.id}: ${(error as Error).message}`))
        }
      }
      for (const id of fresh) if (!prioritized.has(id)) await board.setPriority(id, DEFAULT_PRIORITY)
      this.log(`triage: ${output.result.summary}`)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      await board.release(TRIAGE_LOCK)
    }
  }

  private async reviewSignal(id: string, config: Config): Promise<Verdict> {
    const pull = await this.trustedPull(id)
    if (pull?.state === 'merged') return { kind: 'merged', pull, approvers: [], feedback: [] }
    const { comments, pad } = await this.workpad(id)
    const since = pad?.state.waiting?.kind === 'review' ? pad.state.waiting.since : ''
    const human = [...comments.filter((comment) => !isAgentComment(comment)), ...(pull?.comments ?? [])].filter((comment) => comment.createdAt >= since)
    const latest = new Map<string, NonNullable<typeof pull>['reviews'][number]>()
    for (const review of pull?.reviews ?? []) {
      if (review.submittedAt >= since && review.state !== 'commented') latest.set(review.author, review)
    }
    const reviews = [...latest.values()]
    const feedback = [
      ...reviews.filter((review) => review.state === 'changes_requested' && review.body.trim()).map((review) => review.body),
      ...(pull?.feedback ?? []).map((comment) => comment.body),
      ...human.map((comment) => stripCommand(comment.body)).filter((text): text is string => Boolean(text)),
    ]

    if (human.some((comment) => isCommand(comment.body, 'rework'))) return { kind: 'rework', pull, approvers: [], feedback }
    const fixFrom = human.map((comment) => comment.body.trim().match(FIX_FROM)).filter(Boolean).at(-1)
    if (fixFrom) {
      const allowed = config.stages.slice(0, config.stages.findIndex((stage) => stage.name === 'merge') + 1).map((stage) => stage.name)
      const stage = fixFrom[1] ?? ''
      if (!allowed.includes(stage)) {
        return { kind: 'invalid', pull, approvers: [], feedback, error: `Unknown stage \`${stage}\` in /fix_from. Use one of: ${allowed.join(', ')}.` }
      }
      return { kind: 'fix', pull, approvers: [], feedback, from: stage }
    }
    if (human.some((comment) => isCommand(comment.body, 'fix')) || reviews.some((review) => review.state === 'changes_requested')) {
      return { kind: 'fix', pull, approvers: [], feedback, from: 'plan' }
    }
    const approvers = [
      ...new Set([
        ...reviews.filter((review) => review.state === 'approved').map((review) => review.author),
        ...human.filter((comment) => isCommand(comment.body, 'merge')).map((comment) => comment.author),
      ]),
    ]
    return { kind: pull?.state === 'open' && approvers.length >= config.review.approvals ? 'merge' : 'wait', pull, approvers, feedback }
  }

  private async rejectCommand(id: string, error: string) {
    const { board } = this.options
    await board.addComment(id, agentComment('error', error))
    const { pad } = await this.workpad(id)
    if (!pad?.state.waiting) return
    pad.state.waiting.since = new Date(Date.now() + 1).toISOString()
    await board.updateComment(pad.id, renderWorkpad(pad.state, pad.text))
  }

  private async mustGetTask(id: string) {
    const task = await this.options.board.getTask(id)
    if (!task) throw new Error(`task ${id} not found`)
    return task
  }

  private async runStage(task: Task, stage: Stage, config: Config, context: StageContext): Promise<StageAttempt> {
    const cannotStart = (reason: string): StageAttempt => ({ result: failed(reason), usage: NO_USAGE, fatal: true })
    const harness = this.options.harnesses[stage.harness]
    if (!harness) return cannotStart(`harness ${stage.harness} is not available`)
    const file = parseStageFile(this.read('stages', `${stage.name}.md`))
    if (!file.ok) return cannotStart(`stages/${stage.name}.md: ${file.error}`)
    if (file.skills.length > 0 && stage.harness !== 'claude') return cannotStart(`skills in the ${stage.name} stage are supported only with the claude harness`)
    const { skills, missing } = resolveSkills(file.skills, { repo: this.options.repo, home: this.options.home })
    if (missing.length > 0) return cannotStart(`skills not found for the ${stage.name} stage: ${missing.join(', ')}`)
    const instructions = renderInstructions(file.template, {
      issue: {
        id: task.id,
        title: task.title,
        body: task.body,
        state: task.state ?? '',
        assignees: task.assignees,
        priority: task.priority ?? null,
        blockers: task.openBlockers,
      },
      stage: stage.name,
      attempt: context.attempt,
      artifacts: context.artifacts,
      review: context.review ?? '',
      language: { docs: config.language.docs },
      formats: { story: readFormat(this.options.settingsDir, 'story') },
    })
    if (!instructions.ok) return cannotStart(`stages/${stage.name}.md: ${instructions.error}`)
    try {
      await this.options.workspaces.runHook('before_run', context.workspace)
    } catch (error) {
      return { result: failed((error as Error).message), usage: NO_USAGE }
    }
    const prompt = buildPrompt({
      task,
      stage: stage.name,
      instructions: instructions.text,
      ...(context.gate ? { gate: context.gate } : {}),
      artifacts: context.artifacts,
      workpad: context.workpad,
      ...(context.conversation ? { conversation: context.conversation } : {}),
      attempt: context.attempt,
      language: config.language.docs,
      ...(context.review ? { review: context.review, reviewMode: context.reviewMode ?? 'rework' } : {}),
      ...(context.merge ? { merge: context.merge } : {}),
      ...(stage.name === 'merge' && config.transitions.merge === 'smart' ? { mergeCriteria: this.read('smart', 'merge.md') } : {}),
    })

    const controller = new AbortController()
    const stop = () => controller.abort()
    context.signal.addEventListener('abort', stop, { once: true })
    let reason: string | undefined
    const { stage: stageTimeout, stall } = config.timeouts
    const deadline = setTimeout(() => {
      reason = `stage timed out after ${stageTimeout / 60_000} min`
      controller.abort()
    }, stageTimeout)
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (!stall) return
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        reason = `stage stalled: no harness events for ${stall / 60_000} min`
        controller.abort()
      }, stall)
    }
    arm()

    try {
      const output = await harness.runStage({
        taskId: task.id,
        stage: stage.name,
        prompt,
        model: stage.model,
        effort: stage.effort,
        cwd: context.workspace,
        signal: controller.signal,
        onEvent: arm,
        skills: skills.filter((skill) => skill.source !== 'project'),
        ...(stage.sandbox ? { sandbox: stage.sandbox } : {}),
        ...(stage.network !== undefined ? { network: stage.network } : {}),
        ...(stage.permissionMode ? { permissionMode: stage.permissionMode } : {}),
      })
      return reason ? { ...output, result: failed(reason) } : output
    } finally {
      clearTimeout(deadline)
      clearTimeout(watchdog)
      context.signal.removeEventListener('abort', stop)
      if (!context.signal.aborted) await this.options.workspaces.runHook('after_run', context.workspace)
    }
  }

  private async fail(id: string, stage: Stage, state: WorkpadState, result: StageResult, config: Config, fatal: boolean) {
    state.attempt++
    state.lastError = publicText(result.summary, this.options.home)
    if (fatal) {
      const text = `**The \`${stage.name}\` stage cannot start.**\n\n${state.lastError}\n\nFix the cause, then reply in a comment to retry.`
      const comment = await this.options.board.addComment(id, agentComment('error', text))
      state.attempt = 0
      state.waiting = { kind: 'error', stage: stage.name, commentId: comment.id, since: new Date().toISOString() }
      await this.options.board.setState(id, 'needs-input')
      return
    }
    if (state.attempt < config.retry.max_attempts) {
      const delay = Math.min(10_000 * 2 ** (state.attempt - 1), config.retry.max_backoff)
      state.retryAt = new Date(Date.now() + delay).toISOString()
      return
    }
    const text = `**The \`${stage.name}\` stage failed ${state.attempt} times.**\n\n${state.lastError}\n\nReply in a comment to retry.`
    const comment = await this.options.board.addComment(id, agentComment('error', text))
    state.attempt = 0
    state.waiting = { kind: 'error', stage: stage.name, commentId: comment.id, since: new Date().toISOString() }
    await this.options.board.setState(id, 'needs-input')
  }

  private request(stage: string, result: StageResult) {
    if (result.outcome === 'approval') {
      return `**The \`${stage}\` stage asks for approval.**\n\n${result.summary}\n\nReply to approve, or describe the changes you want.`
    }
    const questions = (result.questions ?? [result.summary]).map((question, index) => `${index + 1}. ${question}`).join('\n')
    return `**Questions from the \`${stage}\` stage:**\n\n${questions}\n\nReply in a comment to continue.`
  }

  private conversation(comments: Comment[], waiting: NonNullable<WorkpadState['waiting']>) {
    const request = comments.find((comment) => comment.id === waiting.commentId)
    return {
      request: request ? commentText(request) : '',
      replies: repliesSince(comments, waiting.commentId).map((comment) => comment.body),
      approval: waiting.kind === 'approval',
    }
  }

  private gate(stage: Stage, config: Config) {
    const gate = GATES[stage.name]
    if (!gate) return undefined
    return { mode: config.transitions[gate.transition], criteria: this.read('smart', `${gate.criteria}.md`) }
  }

  private async workpad(id: string): Promise<{ comments: Comment[]; pad: Workpad | undefined }> {
    const comments = await this.comments(id)
    return { comments, pad: findWorkpad(comments) }
  }

  private async comments(id: string) {
    return this.trust.only(await this.options.board.listComments(id))
  }

  private async trustedPull(id: string): Promise<PullRequest | undefined> {
    const pull = await this.options.board.pullRequest(id)
    if (!pull) return undefined
    return { ...pull, reviews: await this.trust.only(pull.reviews), comments: await this.trust.only(pull.comments), feedback: await this.trust.only(pull.feedback) }
  }

  private async lock(name: string, ttl: number) {
    const { board } = this.options
    if (await board.claim(name)) {
      this.heldLocks.delete(name)
      return true
    }
    const now = Date.now()
    const seen = this.heldLocks.get(name)
    const held = !seen || now - seen.last > ttl ? { first: now, last: now } : { first: seen.first, last: now }
    this.heldLocks.set(name, held)
    if (now - held.first < ttl) return false
    this.heldLocks.delete(name)
    this.log(`the lock conveyor-lock/${name} is older than ${ttl / 60_000} min: released`)
    await board.release(name)
    return board.claim(name)
  }

  private async answered(id: string) {
    const { comments, pad } = await this.workpad(id)
    return repliesSince(comments, pad?.state.waiting?.commentId).length > 0
  }

  private async retryDue(id: string, now: number) {
    const { pad } = await this.workpad(id)
    return !pad?.state.retryAt || Date.parse(pad.state.retryAt) <= now
  }

  private pickable(task: Task, config: Config, me: string) {
    const assignee = config.pickup.assignee === 'me' ? me : config.pickup.assignee
    if (task.assignees.length > 0) return task.assignees.includes(assignee)
    return config.pickup.include_unassigned
  }

  private sorted(tasks: Task[], me: string) {
    const rank = (task: Task) => (task.assignees.includes(me) ? 0 : 1)
    return [...tasks].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.localeCompare(b.createdAt) ||
        Number(a.id) - Number(b.id),
    )
  }

  private read(...path: string[]) {
    const file = join(this.options.settingsDir, ...path)
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  private log(message: string) {
    this.options.log?.(message)
  }
}

function withoutOwner(task: Task): Task {
  const { owner: _owner, ...rest } = task
  return rest
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isCommand(text: string, command: 'merge' | 'rework' | 'fix') {
  return new RegExp(`^/${command}(\\s|$)`, 'i').test(text.trim())
}

function stripCommand(text: string): string | undefined {
  const trimmed = text.trim()
  if (isCommand(trimmed, 'merge')) return undefined
  const match = trimmed.match(/^\/(?:rework|fix|fix_from:?\s+[a-z][a-z0-9-]*)(?:\s+|$)/i)
  return (match ? trimmed.slice(match[0].length) : trimmed).trim() || undefined
}
