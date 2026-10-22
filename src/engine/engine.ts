import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { join } from 'node:path'
import { compareIds, onBoard, taskRef, taskSlug, type Board, type Where, type Comment, type PullRequest, type Task, type TaskForm } from '../board/board.js'
import type { Config, Harness as HarnessName, LoadResult, Stage } from '../config.js'
import type { Harness, QuotaWindow, StageOutput, StageResult } from '../harness/harness.js'
import { LENGTH_LIMIT, NO_USAGE, failed, usageLimitUntil } from '../harness/harness.js'
import { isModelError } from '../models.js'
import { resolveSkills } from '../skills.js'
import { QuotaStore, type UsageLedger } from '../usage.js'
import { taskBranch, type Workspaces } from '../workspaces.js'
import { Artifacts } from './artifacts.js'
import { buildPrompt, buildTriagePrompt, type GateMode } from './prompt.js'
import { releaseClaim } from './release.js'
import { sessionFile, sessionWriter, removeSession } from '../session-log.js'
import type { RepoWorkspaces } from '../multi-workspaces.js'
import { publicText, redactSecrets } from './redact.js'
import { createRun } from '../run.js'
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
  type RepoPull,
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
  redact?: (text: string) => string
  wake?: () => void
  leftovers?: (workspace: string, slug: string) => Promise<string[]>
}

type Running = { controller: AbortController; promise: Promise<void> }

export type Activity = { stage: string; startedAt: string; lastOutputAt: string }

type StageAttempt = StageOutput & { fatal?: boolean }

type Verdict = {
  kind: 'merged' | 'rework' | 'fix' | 'merge' | 'invalid' | 'stale' | 'wait'
  pull: PullRequest | undefined
  approvers: string[]
  feedback: string[]
  from?: string
  error?: string
  repo?: string
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
  column: Task['state']
}

const TRIAGE_LOCK = 'triage'
const DEFAULT_PRIORITY = 3
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
const CHECKS_GRACE = 5 * 60_000
const MERGE_LOCK = 'merge'
const FIX_LOCK = 'fix'
const BASE_SOURCE = 'base'
const SOURCE_STAGE = 'source'
export const BASE_FIX = '<!-- conveyor:base-fix -->'
const LOCK_TTL = 10 * 60_000

type StageContext = {
  workspace: string
  artifacts: Record<string, string>
  workpad: string
  gate: { mode: GateMode; criteria: string } | undefined
  conversation: { request: string; replies: string[]; approval: boolean } | undefined
  notes?: { author: string; at: string; text: string }[]
  split?: boolean
  attempt: number
  signal: AbortSignal
  review?: string | undefined
  reviewMode?: 'fix' | 'rework' | undefined
  merge?: string | undefined
  parts?: { list: string[]; current: number } | undefined
}

const PICKUP: Record<Config['pickup_from'], TaskForm[]> = {
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
  private readonly activities = new Map<string, Activity>()
  private readonly halt = new AbortController()
  private readonly held = new Set<string>()
  private draining = false
  private slotWaiters: Task[] = []
  private readonly broke = new Set<string>()
  private readonly deciding = new Set<string>()
  private readonly reportedRed = new Set<string>()
  private originPath?: Promise<string | undefined>
  private readonly misplaced = new Set<string>()
  private readonly yielded = new Set<string>()
  private readonly free = new Set<string>()
  private repoSet?: string[]
  private baseRed?: { sha: string; fix?: string; failed: string[]; repairing?: boolean }
  private fixer?: string
  private readonly verifying = new Map<string, string>()
  private readonly mergeQueue = new Map<string, { priority: number; since: number }>()
  private mergeTurn: string | undefined
  private readonly limited = new Map<string, string>()
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
    if (this.draining) return
    try {
      await this.guardBase(config)
      this.repoSet = await this.repoWorkspaces(config)?.names()
    } catch (error) {
      this.log(`the base branch check failed: ${(error as Error).message}; no task starts or merges in this cycle`)
      return
    }
    await this.probeQuotas(config)
    await this.triage(config).catch((error: unknown) => this.log(`triage failed: ${(error as Error).message}`))
    if (this.halt.signal.aborted || this.draining) return

    const resumable: Task[] = []
    const fresh: Task[] = []
    let awaitingMe = 0
    let awaitingReview = 0
    let backingOff = 0
    const parked = new Set<string>()
    const landing = new Set<string>()
    let labeled: string | undefined
    const now = Date.now()

    const listedTasks = await board.listTasks()
    await board
      .syncMirror(listedTasks)
      .then((synced) => synced && this.log(`board: moved ${synced} cards to the column of their conveyor:: label`))
      .catch((error: unknown) => this.log(`board: the project columns were not synced: ${(error as Error).message}`))
    for (const listed of listedTasks) {
      if (this.isFixTask(listed) && (await this.trust.trusted(listed.author, this.taskWhere(listed.id)))) {
        labeled = listed.id
        break
      }
    }
    for (const listed of listedTasks) {
      if (this.running.has(listed.id) || this.held.has(listed.id)) continue
      if (!(await this.trust.trusted(listed.author, this.taskWhere(listed.id)))) {
        if (!this.untrusted.has(listed.id)) this.log(`task ${listed.id}: skipped: its author @${listed.author} has no write access to ${this.repoSet ? 'every repository of the feature' : 'the repository'}`)
        this.untrusted.add(listed.id)
        continue
      }
      const task = (await this.releaseIfExpired(listed, me, config, now)) ? withoutOwner(listed) : listed
      if (task.owner && task.owner !== me) continue
      const owned = task.owner === me
      if (owned && !task.assignees.includes(me)) await board.setOwner(task.id, me).catch((error: unknown) => this.log(`task ${task.id}: assigning @${me} failed: ${(error as Error).message}`))
      switch (task.state) {
        case 'review': {
          const verdict = await this.reviewSignal(task.id, config)
          if (verdict.kind === 'invalid') await this.rejectCommand(task.id, verdict.error ?? 'Invalid command.')
          if (verdict.kind === 'stale' && verdict.pull) await this.reviewAgain(task.id, verdict.pull.headSha, verdict.repo, verdict.pull.headAt)
          if (verdict.kind !== 'wait' && verdict.kind !== 'invalid' && verdict.kind !== 'stale') (owned ? resumable : fresh).push(task)
          else if (owned) awaitingReview++
          break
        }
        case 'rework':
          ;(owned ? resumable : fresh).push(task)
          break
        case 'needs-input': {
          const { comments, pad } = await this.workpad(task.id)
          const answered = repliesSince(comments, pad?.state.waiting?.commentId).length > 0
          if (answered) (owned ? resumable : fresh).push(task)
          else if (owned) awaitingMe++
          break
        }
        case 'in-progress':
        case 'queued': {
          if (!owned) fresh.push(task)
          else {
            const { pad } = await this.workpad(task.id)
            if (!pad?.state.retryAt || Date.parse(pad.state.retryAt) <= now) resumable.push(task)
            else if (task.state === 'in-progress' && !pad.state.parked) backingOff++
            if (pad?.state.parked) parked.add(task.id)
            if (pad?.state.stage === LAND) landing.add(task.id)
          }
          break
        }
        case undefined:
        case 'backlog':
          if (!task.form) break
          if (owned) resumable.push(task)
          else if (PICKUP[config.pickup_from].includes(task.form) && task.openBlockers === 0 && this.pickable(task, config, me)) {
            fresh.push(task)
          }
          break
      }
    }

    if (this.halt.signal.aborted || this.draining) return
    for (const id of this.mergeQueue.keys()) if (!landing.has(id) && !this.running.has(id) && !this.held.has(id)) this.leaveMergeQueue(id)
    const previous = this.fixer
    const fixer = (this.fixer = this.baseRed ? (this.baseRed.fix ?? '') : labeled)
    if (fixer && fixer !== previous) this.log(`CI freeze: task ${taskRef(fixer)} fixes the CI; ${this.baseRed ? 'new tasks and merges wait' : 'merges wait'}`)
    if (previous && fixer === undefined) this.log(`CI freeze over: task ${taskRef(previous)} no longer fixes the CI; merges continue`)
    let slots = config.limits.running - this.running.size - backingOff
    let waiting = 0
    this.slotWaiters = []
    for (const task of this.sorted(resumable, me)) {
      if (parked.has(task.id)) {
        this.free.add(task.id)
        this.start(task, config)
        continue
      }
      if (slots > 0 || task.id === fixer) {
        this.start(task, config)
        slots--
        continue
      }
      waiting++
      this.slotWaiters.push(task)
      if (task.state === 'needs-input' || (task.state === 'in-progress' && !parked.has(task.id))) await board.setState(task.id, 'queued')
    }

    const overBudget =
      (config.limits.daily_tokens > 0 && this.options.usage.today() >= config.limits.daily_tokens) ||
      config.stages.some((stage) => this.quotaBlock(stage.harness, config) !== undefined)
    const blocked = waiting > 0 || overBudget || awaitingMe >= config.limits.awaiting_me || awaitingReview >= config.limits.awaiting_review

    for (const task of this.sorted(fresh, me)) {
      const fix = task.id === fixer
      if (this.baseRed && !fix) continue
      if (!fix && (blocked || slots <= 0)) break
      if (fix && overBudget) continue
      const wrong = await this.wrongProject(task.id, config)
      if (wrong) {
        if (!this.misplaced.has(task.id)) this.log(`task ${task.id}: skipped: ${wrong}`)
        this.misplaced.add(task.id)
        continue
      }
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

  drain() {
    this.draining = true
    return [...this.running.keys()]
  }

  abort() {
    this.halt.abort()
    for (const running of this.running.values()) running.controller.abort()
    return [...this.running.keys()]
  }

  async stop() {
    this.abort()
    await this.idle()
  }

  activity(): Record<string, Activity> {
    return Object.fromEntries(this.activities)
  }

  async hold<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.held.add(id)
    try {
      const running = this.running.get(id)
      running?.controller.abort()
      await running?.promise
      return await work()
    } finally {
      this.held.delete(id)
    }
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
      .finally(() => {
        this.running.delete(task.id)
        this.free.delete(task.id)
        if (this.yielded.delete(task.id)) this.options.wake?.()
      })
    this.running.set(task.id, { controller, promise })
  }

  private async execute(initial: Task, config: Config, signal: AbortSignal) {
    const { board, workspaces } = this.options
    const id = initial.id
    const comments = await this.comments(id)
    const pad = findWorkpad(comments)
    const state: WorkpadState = { attempt: 0, ...pad?.state }
    const command = initial.state !== 'review' && state.waiting?.kind === 'error' ? await this.reviewSignal(id, config) : undefined
    const verdict = initial.state === 'review' ? await this.reviewSignal(id, config) : command?.kind === 'fix' || command?.kind === 'rework' ? command : undefined
    if (verdict?.kind === 'stale' || verdict?.kind === 'wait' || verdict?.kind === 'invalid') return
    const pull = verdict?.pull
    const rework = initial.state === 'rework' || verdict?.kind === 'rework'
    const waiting = state.waiting
    const approvalStage = waiting?.kind === 'approval' ? waiting.stage : undefined
    const conversation = waiting && waiting.kind !== 'review' && waiting.stage !== SOURCE_STAGE ? this.conversation(comments, waiting) : undefined
    if (waiting?.kind === 'error' && waiting.stage === LAND) state.landAttempts = 0
    if (waiting) delete state.runs
    delete state.waiting
    delete state.retryAt
    delete state.parked
    state.private = Object.values(config.artifacts).some((artifact) => artifact.store === 'path')

    const run: TaskRun = {
      id,
      config,
      signal,
      state,
      text: pad?.text ?? '',
      padId: pad?.id,
      workspace: '',
      column: initial.state,
      artifacts: new Artifacts(board, workspaces, config, this.options.home, this.options.redact ?? ((text) => redactSecrets(text))),
      save: async () => {
        state.heartbeat = new Date().toISOString()
        const body = renderWorkpad(state, run.text)
        if (run.padId) await board.updateComment(run.padId, body)
        else run.padId = (await board.addComment(id, body)).id
      },
    }

    const wrong = await this.wrongProject(id, config)
    if (wrong) {
      await this.stopWithError(run, state.stage ?? waiting?.stage ?? 'start', `**This task cannot run here:** ${wrong}`)
      return
    }
    if (initial.state !== 'in-progress' && (initial.state !== 'queued' || !pad?.state.parked)) {
      await board.setState(id, 'in-progress')
      run.column = 'in-progress'
    }
    if (initial.form) {
      state.form = initial.form
      await board.setForm(id, undefined)
    }
    state.branch = await board.branchUrl(taskBranch(id)).catch(() => initial.url)
    await run.save()
    if (!state.source && !state.stage && !rework && !verdict) {
      const decided = await this.chooseSource(run, comments, waiting)
      if (!decided) return
    }
    run.workspace = (await workspaces.prepare(id, state.source && state.source !== BASE_SOURCE ? state.source : undefined)).path

    const names = config.stages.map((stage) => stage.name)
    const mergeIndex = names.indexOf('merge')
    if (rework || verdict?.kind === 'fix') {
      const since = waiting?.kind === 'review' ? waiting.since : ''
      const feedback =
        verdict?.feedback ??
        comments.filter((comment) => !isAgentComment(comment) && comment.createdAt >= since).map((comment) => comment.body)
      const failure = state.mergeError ? `The merge failed: ${state.mergeError}` : state.lastError ? `The last attempt failed: ${state.lastError}` : ''
      for (const key of ['landing', 'mergeError', 'landAttempts', 'lastError'] as const) delete state[key]
      state.attempt = 0
      state.review = [failure, ...feedback].filter(Boolean).join('\n\n') || 'The reviewer asked for changes. Read the issue comments for details.'
      if (rework) {
        if (pull?.state === 'open') await board.closePullRequest(id)
        for (const repo of Object.keys(state.repos ?? {})) if (!state.repos?.[repo]?.merged) await board.closePullRequest(id, repo)
        delete state.repos
        delete state.pull
        await workspaces.reset(id)
        run.text = ''
        delete state.partBase
        state.reviewMode = 'rework'
        state.stage = names[names.indexOf('plan') + 1] ?? 'merge'
        if (config.parts === 'together' && state.parts) {
          state.part = 0
          await board.setPart(id, `1/${state.parts.length}`)
        }
      } else {
        state.reviewMode = 'fix'
        state.stage = verdict?.from ?? 'plan'
      }
      if (state.followUp) {
        await workspaces.reset(id)
        delete state.followUp
      }
      this.log(`task ${id}: ${state.reviewMode} from ${state.stage}`)
    } else if (verdict?.kind === 'merged') {
      state.landing = 'success'
      delete state.stage
    } else if (verdict?.kind === 'merge') {
      state.stage = LAND
      this.log(`task ${id}: approved by ${verdict.approvers.join(', ')}`)
    }

    let pendingPull: { merge?: 'land' | 'review'; summary: string } | undefined
    if (!state.landing && state.stage !== LAND) {
      const form = initial.form ?? state.form
      const start = state.stage ?? (form === 'idea' ? 'story' : form === 'story' ? 'plan' : names[names.indexOf('plan') + 1])
      const chain = await this.runChain(run, config.stages.slice(names.indexOf(start ?? 'merge'), mergeIndex + 1), {
        approvalStage,
        conversation,
      })
      if (chain.status !== 'done') return
      delete state.review
      delete state.reviewMode
      if (this.collectsParts(state, config)) {
        await this.nextCollectedPart(run, initial)
        return
      }
      pendingPull = chain
      if ((await workspaces.ahead(id).catch(() => 1)) === 0) {
        await board.addComment(id, agentComment('note', 'Nothing to merge: the task branch has no changes against the base branch, so the conveyor opens no pull request.'))
        this.log(`task ${id}: nothing to merge; the branch has no changes against the base branch`)
        state.landing = 'success'
        delete state.stage
      }
    }

    if (!state.landing && state.stage !== LAND && pendingPull) {
      const chain = pendingPull
      const task = (await board.getTask(id)) ?? initial
      const together = config.parts === 'together' && state.parts !== undefined
      const part = state.parts && !together ? { index: (state.part ?? 0) + 1, total: state.parts.length, title: state.parts[state.part ?? 0] ?? '' } : undefined
      const title = part ? `${task.title} (part ${part.index}/${part.total}: ${part.title})` : task.title
      const body = together ? `${this.partsText(id, state, state.parts?.length ?? 0)}\n\n${chain.summary}` : `Part of ${board.reference(id)}${part ? `, part ${part.index} of ${part.total}: ${part.title}` : ''}.\n\n${chain.summary}`
      const multi = this.repoWorkspaces(config)
      const needed = `${config.review.approvals} ${config.review.approvals === 1 ? 'approval' : 'approvals'}`
      let request: string
      try {
        if (multi) {
          state.repos ??= {}
          for (const repo of this.repoOrder(state, await multi.changed(id))) {
            if (state.repos[repo]) continue
            const opened = await board.openPullRequest(id, title, body, repo)
            state.repos[repo] = { number: opened.number, url: opened.url, headSha: opened.headSha }
          }
          if (together) for (const repo of Object.keys(state.repos)) await board.readyPullRequest(id, title, body, repo)
          const listed = this.repoOrder(state, Object.keys(state.repos)).map((repo) => `- \`${repo}\`: ${state.repos?.[repo]?.url}`).join('\n')
          request = `**The merge requests are ready for review**, one per repository, in merge order:\n\n${listed}\n\nApprove each merge request in its project with its Approve button (${needed} each); a comment \`/approve\` there is the GitLab quick action and does the same. GitLab may not let the author of a merge request approve it; the conveyor opens them as its own user, so a teammate approves. The feature merges as a whole when every merge request is approved and green. A plain comment is a note for the team and does not change the task.`
        } else {
          const opened = await board.openPullRequest(id, title, body)
          state.pull = { number: opened.number, url: opened.url }
          if (together) await board.readyPullRequest(id, title, body)
          request = `**The pull request is ready for review:** ${opened.url}\n\nApprove it with an Approve review or a comment \`/approve\` (${needed} needed). A plain comment is a note for the team and does not change the task.`
        }
      } catch (error) {
        await this.stopWithError(run, 'merge', `**The ${multi ? 'merge request' : 'pull request'} was not opened.**\n\n${publicText((error as Error).message, this.options.home)}`)
        return
      }
      if (chain.merge === 'review') {
        delete state.stage
        state.waiting = { kind: 'review', since: new Date().toISOString() }
        await board.addComment(id, agentComment('review', `${request}\n\n${commandHelp(config)}`))
        await board.setState(id, 'review')
        await board.setStage(id, undefined)
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

    if (state.landing === 'success' && (state.verify || Object.values(state.repos ?? {}).some((entry) => entry.verify)) && !(await this.verifyBase(run))) return
    if (state.broken) {
      this.verifying.set(state.broken, id)
      const repair = config.stages.slice(mergeIndex + 1).filter((stage) => stage.when === 'failure' || stage.when === 'always')
      const resumeRepair = state.stage ? repair.findIndex((stage) => stage.name === state.stage) : 0
      if (!state.stage) await workspaces.reset(id)
      const fixed = await this.runChain(run, repair.slice(Math.max(resumeRepair, 0)), {
        merge: `The base branch CI failed after this task was merged (commit ${state.broken.slice(0, 7)}). Fix the base branch in the task branch, which starts from the latest base branch. The conveyor opens a follow-up pull request and merges it after its checks pass.`,
      })
      if (fixed.status !== 'done') return
      if ((await workspaces.ahead(id).catch(() => 1)) === 0) {
        this.log(`task ${id}: the repair of the base branch changed nothing; the task finishes, and the check of the base branch decides whether it still needs a fix`)
        this.verifying.delete(state.broken)
        delete state.broken
      } else {
        const task = (await board.getTask(id)) ?? initial
        const opened = await board.openPullRequest(id, `Fix the base branch after: ${task.title}`, `Part of ${board.reference(id)}: the base branch CI failed after its merge.\n\n${fixed.summary}`)
        state.pull = { number: opened.number, url: opened.url }
        delete state.broken
        delete state.landing
        state.stage = LAND
        await run.save()
        return
      }
    }

    const landing = state.landing ?? 'success'
    if (landing === 'failure' && state.mergeError?.startsWith('checks failed')) {
      const { held } = await this.takeFix(id)
      if (held) {
        delete state.landing
        state.landAttempts = Math.max(0, (state.landAttempts ?? 1) - 1)
        state.stage = LAND
        state.parked = `waits: ${held}`
        state.retryAt = new Date(Date.now() + LAND_WAIT).toISOString()
        await run.save()
        this.log(`task ${id}: merge failed; ${held}, then this task tries again on the latest base branch`)
        return
      }
    }
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

    if (state.parts && (state.part ?? 0) < state.parts.length - 1) {
      for (const key of ['landing', 'mergeError', 'landAttempts', 'review', 'reviewMode', 'lastError', 'runs', 'partBase'] as const) delete state[key]
      state.attempt = 0
      state.part = (state.part ?? 0) + 1
      if (initial.fixing || this.fixer === id) await board.setFixing(id, false)
      state.stage = names[names.indexOf('plan') + 1] ?? 'merge'
      await workspaces.reset(id)
      await board.setPart(id, `${state.part + 1}/${state.parts.length}`)
      await run.save()
      this.log(`task ${id}: part ${state.part} of ${state.parts.length} merged, part ${state.part + 1} starts`)
      return
    }

    for (const key of ['stage', 'landing', 'mergeError', 'landAttempts', 'review', 'lastError', 'checksWait', 'repairs', 'runs', 'stageBase', 'partBase', 'lastResult'] as const) delete state[key]
    state.attempt = 0
    await board.setState(id, 'done')
    await board.setStage(id, undefined)
    if (initial.fixing || this.fixer === id) await board.setFixing(id, false)
    if (state.parts) await board.setPart(id, undefined)
    await run.save()
    if (config.close_on_done) await board.closeTask(id)
    await board.release(id)
    await workspaces.remove(id)
    await workspaces.deleteBranch(id).catch((error: unknown) => this.log(`task ${id}: ${(error as Error).message}`))
    removeSession(sessionFile(this.options.home, config.board.project, id))
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

    for (const [index, stage] of stages.entries()) {
      if (signal.aborted) return { status: 'stopped', summary }
      if (this.free.has(id) && id !== this.fixer) {
        if ([...this.running.keys()].filter((key) => !this.free.has(key)).length >= config.limits.running) {
          state.stage = stage.name
          state.parked = 'waits for a free running slot'
          state.retryAt = new Date(Date.now() + LAND_WAIT).toISOString()
          await this.column(run, 'queued')
          await run.save()
          this.log(`task ${id}: waits for a free running slot before stage ${stage.name}`)
          return { status: 'stopped', summary }
        }
        this.free.delete(id)
      }
      if (stage.name === 'merge' && this.collectsParts(state, config)) break
      if (stage.name === 'review' && this.collectsParts(state, config)) continue
      const waiter = index > 0 ? await this.higherWaiter(id) : undefined
      if (waiter) {
        state.stage = stage.name
        await run.save()
        await board.setState(id, 'queued')
        this.yielded.add(id)
        this.log(`task ${id}: gives its slot to task ${taskRef(waiter.id)} with a higher priority; it continues at stage ${stage.name}`)
        return { status: 'stopped', summary }
      }
      if (this.draining) {
        state.stage = stage.name
        await run.save()
        this.log(`task ${id}: stops before stage ${stage.name}; it starts there on the next start`)
        return { status: 'stopped', summary }
      }
      const held = stage.name === 'merge' ? this.heldBy(id) : undefined
      if (held) {
        state.stage = stage.name
        state.parked = `waits: ${held}`
        state.retryAt = new Date(Date.now() + LAND_WAIT).toISOString()
        await run.save()
        this.log(`task ${id}: stops before stage ${stage.name}; ${held}`)
        return { status: 'stopped', summary }
      }
      state.stage = stage.name
      const blockedUntil = this.quotaBlock(stage.harness, config)
      if (blockedUntil) {
        state.retryAt = blockedUntil
        await run.save()
        this.log(`task ${id}: stage ${stage.name} waits for the ${stage.harness} subscription window until ${blockedUntil}`)
        return { status: 'stopped', summary }
      }
      const runs = state.runs?.[stage.name] ?? 0
      if (runs >= config.retry.max_attempts) {
        await this.stopWithError(run, stage.name, `**Stage \`${stage.name}\` ran ${runs} times without an answer from a human**, so the conveyor stops it here instead of running it again in a loop. Its last result: ${state.lastResult ?? 'unknown'}`)
        return { status: 'stopped', summary }
      }
      await this.column(run, 'in-progress')
      state.stageBase = await workspaces.mark(id).catch(() => undefined)
      if (state.parts && !state.partBase && stage.name === config.stages[config.stages.findIndex((entry) => entry.name === 'plan') + 1]?.name) state.partBase = state.stageBase
      await run.save()
      this.log(`task ${id}: stage ${stage.name} started (${stage.harness}${stage.model ? `, ${stage.model}` : ''})`)
      const task = (await board.getTask(id)) ?? (await this.mustGetTask(id))
      if (task.stage !== stage.name) await board.setStage(id, stage.name)
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
          notes: teamNotes(comments),
          split: state.split ?? false,
          attempt: state.attempt,
          signal,
          review: state.review,
          reviewMode: state.reviewMode,
          merge: options.merge,
          parts: state.parts && (config.stages.findIndex((entry) => entry.name === stage.name) > config.stages.findIndex((entry) => entry.name === 'plan') || (stage.name === 'plan' && (state.part ?? 0) > 0)) ? { list: state.parts, current: state.part ?? 0, ...(config.parts === 'together' ? { together: true } : {}) } : undefined,
        })
      } finally {
        clearInterval(heartbeat)
      }
      if (signal.aborted) return { status: 'stopped', summary }
      this.options.usage.add(output.usage.inputTokens + output.usage.outputTokens)
      if (output.quota) this.quotas.set(stage.harness, output.quota)
      const limitedUntil = output.result.outcome === 'failed' ? usageLimitUntil(output.result.summary) : undefined
      if (limitedUntil) {
        this.limited.set(stage.harness, limitedUntil)
        state.retryAt = limitedUntil
        await run.save()
        this.log(`task ${id}: stage ${stage.name} waits for the ${stage.harness} usage limit until ${limitedUntil}; no attempt counted`)
        return { status: 'stopped', summary }
      }
      this.log(`task ${id}: stage ${stage.name} → ${output.result.outcome}: ${output.result.summary}`)
      state.runs = { ...state.runs, [stage.name]: runs + 1 }
      state.lastResult = `${output.result.outcome}: ${publicText(output.result.summary.split('\n')[0] ?? '', this.options.home).slice(0, 300)}`
      conversation = undefined
      await workspaces
        .commitAll(id, `${stage.name}: ${((this.options.redact ?? ((text: string) => redactSecrets(text)))(output.result.summary).split('\n')[0] ?? '').slice(0, 72)}`)
        .catch((error: unknown) => this.log(`task ${id}: commit failed: ${(error as Error).message}`))
      await workspaces
        .push(id)
        .then((sha) => (state.headSha = sha))
        .catch((error: unknown) => this.log(`task ${id}: push failed: ${(error as Error).message}`))
      const multi = this.repoWorkspaces(config)
      for (const [repo, entry] of Object.entries(state.repos ?? {})) {
        const head = multi && !entry.merged ? await multi.repoHead(id, repo).catch(() => undefined) : undefined
        if (head) entry.headSha = head
      }

      let result = output.result
      if (result.workpad) run.text = result.workpad
      if (stage.name === 'merge' && (result.outcome === 'done' || result.outcome === 'approval')) {
        const mode = config.transitions.merge
        merge = mode === 'human' || (mode === 'smart' && result.outcome === 'approval') ? 'review' : 'land'
        result = { ...result, outcome: 'done' }
      }
      if (result.outcome === 'done' && gate?.mode === 'interactive' && options.approvalStage !== stage.name) result = { ...result, outcome: 'approval' }
      if (result.outcome === 'approval' && gate?.mode === 'autonomous') result = { ...result, outcome: 'done' }
      if (stage.name === 'plan' && result.outcome === 'done') await this.takeParts(run, result.parts)
      if (stage.name === 'plan' && result.outcome === 'done' && result.repos) state.mergeOrder = result.repos
      if (result.artifact && result.outcome !== 'failed') {
        const kind = GATES[stage.name] || ['idea', 'story'].includes(result.artifact.kind) ? stage.name : result.artifact.kind
        await run.artifacts.store(task, kind, result.artifact.content, comments)
      }

      if (result.outcome === 'done') {
        state.attempt = 0
        delete state.lastError
        delete state.split
        summary = result.summary
        continue
      }
      if (result.outcome === 'failed') {
        if (result.summary.startsWith(LENGTH_LIMIT)) state.split = true
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
    const turn = { keep: false }
    return this.landTask(run, turn).finally(() => {
      if (!turn.keep) this.leaveMergeQueue(run.id)
    })
  }

  private aheadInMergeQueue(id: string, priority: number | undefined) {
    if (!this.mergeQueue.has(id)) this.mergeQueue.set(id, { priority: priority ?? Number.MAX_SAFE_INTEGER, since: Date.now() })
    this.mergeTurn ??= [...this.mergeQueue].sort(([, a], [, b]) => a.priority - b.priority || a.since - b.since)[0]?.[0]
    return this.mergeTurn === id ? undefined : this.mergeTurn
  }

  private async column(run: TaskRun, column: 'queued' | 'in-progress') {
    if (run.column === column || (column === 'in-progress' && run.column !== 'queued')) return
    await this.options.board.setState(run.id, column)
    run.column = column
  }

  private leaveMergeQueue(id: string) {
    this.mergeQueue.delete(id)
    if (this.mergeTurn === id) this.mergeTurn = undefined
  }

  private async landTask(run: TaskRun, turn: { keep: boolean }): Promise<'success' | 'failure' | 'stop'> {
    const { board } = this.options
    const { id, config, state } = run
    let behind = false
    let inQueue = false
    const wait = async (reason: string) => {
      if (behind) await this.column(run, 'queued')
      else if (!inQueue) await this.column(run, 'in-progress')
      state.stage = LAND
      state.parked = `merge waits: ${reason}`
      state.retryAt = new Date(Date.now() + LAND_WAIT).toISOString()
      await run.save()
      this.log(`task ${id}: merge waits: ${reason}`)
      return 'stop' as const
    }

    const task = await this.mustGetTask(id)
    if (task.openBlockers > 0) return wait('open blockers')
    if (this.baseRed && this.baseRed.fix !== id) return wait(`the base branch CI is red; ${this.baseRed.fix ? `task ${taskRef(this.baseRed.fix)} fixes it first` : 'a fix task is chosen first'}`)
    const held = this.heldBy(id)
    if (held) return wait(held)
    const multi = this.repoWorkspaces(config)
    const queued = (reason: string) => {
      turn.keep = true
      return wait(reason)
    }
    const pending = (reason: string) => {
      if (!this.mergeQueue.has(id)) return wait(reason)
      inQueue = this.mergeTurn !== id
      return queued(reason)
    }
    const inLine = async () => {
      const ahead = this.aheadInMergeQueue(id, task.priority)
      if (ahead) {
        behind = true
        return queued(`queued behind task ${taskRef(ahead)}`)
      }
      await this.column(run, 'in-progress')
      return undefined
    }
    if (multi && state.repos) return this.landRepos(run, multi, wait, { queued, pending, inLine })
    const pull = await board.pullRequest(id)
    if (pull?.state === 'merged') return 'success'
    if (pull?.state === 'open' && pull.draft) return wait('the pull request is a draft; mark it ready for review')
    const review = async (sha: string, at?: string) => {
      delete state.stage
      state.headSha = sha
      state.waiting = { kind: 'review', since: reviewSince(at) }
      await board.addComment(id, agentComment('review', changedText(sha)))
      await board.setState(id, 'review')
      await board.setStage(id, undefined)
      await run.save()
      this.log(`task ${id}: the branch changed after approval, back to review`)
      return 'stop' as const
    }
    if (pull?.state === 'open' && pull.headSha !== state.headSha) return review(pull.headSha, pull.headAt)
    const local = pull?.state === 'open' ? await this.options.workspaces.head(id).catch(() => undefined) : undefined
    if (pull && local && local !== pull.headSha && (await this.options.workspaces.contains(id, pull.headSha).catch(() => false))) {
      let pushed: string
      try {
        pushed = await this.options.workspaces.push(id)
      } catch (error) {
        return wait(`the task branch has commits that are not pushed, and the push failed: ${(error as Error).message.split('\n')[0]}`)
      }
      if (config.transitions.merge !== 'ai') return review(pushed)
      state.headSha = pushed
      return wait('the task branch had commits that were not pushed; they are pushed now and the branch waits for CI')
    }
    let error: string | undefined
    if (!pull || pull.state === 'closed') error = 'the pull request is closed'
    else if (pull.checks === 'pending') return pending('checks are pending')
    else if (pull.mergeable === 'unknown') return pending('the board checks whether the branch merges cleanly')
    else if (pull.blocked && pull.checks !== 'failure') return wait(pull.blocked)
    else if (pull.checks === 'none' && this.checksMayStart(state, pull.headSha)) return wait('no checks yet; waiting for CI to start')
    else if (pull.checks === 'failure') {
      if ((await this.options.workspaces.syncBase(id).catch(() => 'unknown' as const)) === 'rebased') {
        state.headSha = await this.options.workspaces.push(id)
        return wait('checks failed on an older base branch; the branch is rebased onto the latest one and waits for CI')
      }
      error = 'checks failed'
    }
    else if (pull.mergeable === 'no') error = 'the branch has conflicts with the base branch'
    else {
      const line = await inLine()
      if (line) return line
      if (!(await this.lock(MERGE_LOCK, LOCK_TTL))) return queued('another workstation merges')
      let synced: 'current' | 'rebased' | 'conflict' | 'unknown' = 'unknown'
      try {
        synced = await this.options.workspaces.syncBase(id).catch(() => 'unknown' as const)
        if (synced === 'rebased') state.headSha = await this.options.workspaces.push(id)
        if (synced === 'current') {
          const before = await board.baseHead().catch(() => undefined)
          const merged = await board.mergePullRequest(id, config.merge_method, pull.headSha)
          if (!merged.ok) error = merged.error
          const sha = merged.ok ? await board.mergeCommit(id).catch(() => undefined) : undefined
          if (sha) {
            state.verify = { sha, since: new Date().toISOString(), head: pull.headSha, ...(before ? { before } : {}) }
            this.verifying.set(sha, id)
          }
        }
      } finally {
        await board.release(MERGE_LOCK)
      }
      if (synced === 'unknown') return queued('the branch could not be compared with the latest base branch')
      if (synced === 'rebased') return queued('the base branch moved; the branch is rebased onto it and waits for CI')
      if (synced === 'conflict') {
        state.stage = 'merge'
        state.reviewMode = 'fix'
        state.review = 'The base branch moved while this task waited for merge, and the task branch no longer rebases onto it without conflicts. Rebase onto the latest base branch, resolve the conflicts by the intent of each side (the base side is already merged work of other tasks; keep what fulfils both, for example renumber the migration of this task after one another task already added; ask with outcome `questions` when the intents contradict), and run the tests.'
        await run.save()
        this.log(`task ${id}: the base branch moved and the rebase conflicts; the merge stage runs again`)
        return 'stop'
      }
    }
    if (!error) {
      delete state.mergeError
      return 'success'
    }
    return this.landFailed(run, error)
  }

  private async landRepos(
    run: TaskRun,
    multi: RepoWorkspaces,
    wait: (reason: string) => Promise<'stop'>,
    queue: { queued: (reason: string) => Promise<'stop'>; pending: (reason: string) => Promise<'stop'>; inLine: () => Promise<'stop' | undefined> },
  ): Promise<'success' | 'failure' | 'stop'> {
    const { board } = this.options
    const { id, config, state } = run
    const repos = (state.repos ??= {})
    const extra = this.repoOrder(state, (await multi.changed(id).catch(() => [])).filter((repo) => !repos[repo]))
    if (extra.length > 0) {
      const task = await board.getTask(id)
      const opened: string[] = []
      try {
        for (const repo of extra) {
          const pull = await board.openPullRequest(id, task?.title ?? taskRef(id), `Part of ${board.reference(id)}: a repair after a failed merge changed this repository.`, repo)
          repos[repo] = { number: pull.number, url: pull.url, headSha: pull.headSha }
          opened.push(`- \`${repo}\`: ${pull.url}`)
        }
      } catch (error) {
        await this.stopWithError(run, LAND, `**The merge request was not opened.**\n\n${publicText((error as Error).message, this.options.home)}`)
        return 'stop'
      }
      this.log(`task ${id}: a repair changed ${extra.join(', ')}; opened merge requests for them`)
      if (config.transitions.merge !== 'ai') {
        delete state.stage
        state.waiting = { kind: 'review', since: new Date().toISOString() }
        await board.addComment(id, agentComment('review', `**A repair changed more repositories.** New merge requests:\n\n${opened.join('\n')}\n\nApprove each of them in its project; the feature merges as a whole when every merge request is approved and green.`))
        await board.setState(id, 'review')
        await board.setStage(id, undefined)
        await run.save()
        return 'stop'
      }
      await run.save()
      return wait(`opened merge requests for ${extra.join(', ')}; they wait for CI`)
    }
    const review = async (repo: string, sha: string, at?: string) => {
      const entry = repos[repo]
      if (entry) entry.headSha = sha
      delete state.stage
      state.waiting = { kind: 'review', since: reviewSince(at) }
      await board.addComment(id, agentComment('review', changedText(sha, repo)))
      await board.setState(id, 'review')
      await board.setStage(id, undefined)
      await run.save()
      this.log(`task ${id}: the branch of ${repo} changed after approval, back to review`)
      return 'stop' as const
    }
    const ready: { repo: string; sha: string }[] = []
    for (const repo of this.repoOrder(state, Object.keys(repos))) {
      const entry = repos[repo]
      if (!entry || entry.merged) continue
      const pull = await board.pullRequest(id, repo)
      if (pull?.state === 'merged') {
        entry.merged = true
        continue
      }
      if (!pull || pull.state === 'closed') return this.landFailed(run, `the merge request of ${repo} is closed`)
      if (pull.draft) return wait(`the merge request of ${repo} is a draft; mark it ready for review`)
      if (pull.headSha !== entry.headSha) return review(repo, pull.headSha, pull.headAt)
      const local = await multi.repoHead(id, repo).catch(() => undefined)
      if (local && local !== pull.headSha && (await multi.repoContains(id, repo, pull.headSha).catch(() => false))) {
        let pushed: string
        try {
          pushed = await multi.repoPush(id, repo)
        } catch (error) {
          return wait(`${repo} has commits that are not pushed, and the push failed: ${(error as Error).message.split('\n')[0]}`)
        }
        if (config.transitions.merge !== 'ai') return review(repo, pushed)
        entry.headSha = pushed
        return wait(`${repo} had commits that were not pushed; they are pushed now and the branch waits for CI`)
      }
      if (pull.checks === 'pending') return queue.pending(`checks of ${repo} are pending`)
      if (pull.mergeable === 'unknown') return queue.pending(`the board checks whether the branch of ${repo} merges cleanly`)
      if (pull.blocked && pull.checks !== 'failure') return wait(`${repo}: ${pull.blocked}`)
      if (pull.checks === 'none' && this.checksMayStart(entry, pull.headSha)) return wait(`no checks yet in ${repo}; waiting for CI to start`)
      if (pull.checks === 'failure') {
        if ((await multi.repoSync(id, repo).catch(() => 'unknown' as const)) === 'rebased') {
          entry.headSha = await multi.repoPush(id, repo)
          return wait(`checks of ${repo} failed on an older base branch; the branch is rebased onto the latest one and waits for CI`)
        }
        return this.landFailed(run, `checks failed in ${repo}`)
      }
      if (pull.mergeable === 'no') return this.landFailed(run, `the branch of ${repo} has conflicts with its base branch`)
      ready.push({ repo, sha: pull.headSha })
    }
    if (ready.length === 0) {
      delete state.mergeError
      return 'success'
    }
    const line = await queue.inLine()
    if (line) return line
    if (!(await this.lock(MERGE_LOCK, LOCK_TTL))) return queue.queued('another workstation merges')
    let error: string | undefined
    try {
      for (const { repo } of ready) {
        const entry = repos[repo] as RepoPull
        const synced = await multi.repoSync(id, repo).catch(() => 'unknown' as const)
        if (synced === 'unknown') return queue.queued(`${repo} could not be compared with its latest base branch`)
        if (synced === 'rebased') {
          entry.headSha = await multi.repoPush(id, repo)
          return queue.queued(`the base branch of ${repo} moved; the branch is rebased onto it and waits for CI`)
        }
        if (synced === 'conflict') {
          state.stage = 'merge'
          state.reviewMode = 'fix'
          state.review = `The base branch of ${repo} moved while this task waited for merge, and the task branch of ${repo} no longer rebases onto it without conflicts. Rebase it onto the latest base branch, resolve the conflicts by the intent of each side (the base side is already merged work of other tasks; keep what fulfils both; ask with outcome \`questions\` when the intents contradict), and run the tests.`
          await run.save()
          this.log(`task ${id}: the base branch of ${repo} moved and the rebase conflicts; the merge stage runs again`)
          return 'stop'
        }
      }
      for (const { repo, sha } of ready) {
        const entry = repos[repo] as RepoPull
        const before = await board.baseHead(repo).catch(() => undefined)
        const merged = await board.mergePullRequest(id, config.merge_method, sha, repo)
        if (!merged.ok) {
          error = `${repo}: ${merged.error}`
          break
        }
        entry.merged = true
        const commit = await board.mergeCommit(id, repo).catch(() => undefined)
        if (commit) entry.verify = { sha: commit, since: new Date().toISOString(), head: sha, ...(before ? { before } : {}) }
        await run.save()
        this.log(`task ${id}: merged the merge request of ${repo}`)
      }
    } finally {
      await board.release(MERGE_LOCK)
    }
    if (error) return this.landFailed(run, error)
    delete state.mergeError
    return 'success'
  }

  private async landFailed(run: TaskRun, failure: string): Promise<'failure' | 'stop'> {
    const { board } = this.options
    const { id, config, state } = run
    const error = publicText(failure, this.options.home)
    state.mergeError = error
    state.landAttempts = (state.landAttempts ?? 0) + 1
    const names = config.stages.map((stage) => stage.name)
    const repair = config.stages.slice(names.indexOf('merge') + 1).some((stage) => stage.when === 'failure' || stage.when === 'always')
    this.log(`task ${id}: merge failed: ${error}`)
    if (repair && state.landAttempts < config.retry.max_attempts) return 'failure'

    const text = `**The merge failed.**\n\n${error}\n\nFix the cause, then reply with any comment to retry.\n\n${commandHelp(config)}`
    const comment = await board.addComment(id, agentComment('error', text))
    state.stage = LAND
    state.waiting = { kind: 'error', stage: LAND, commentId: comment.id, since: new Date().toISOString() }
    await board.setState(id, 'needs-input')
    await run.save()
    return 'stop'
  }

  private async verdict(sha: string, repo: string | undefined) {
    const checks = await this.options.board.commitChecks(sha, repo).catch(() => 'pending' as const)
    if (checks !== 'cancelled') return checks
    if ((await this.options.board.baseHead(repo).catch(() => sha)) === sha) return 'failure'
    this.log(`a newer commit of the base branch${repo ? ` of ${repo}` : ''} cancelled the CI at ${sha.slice(0, 7)}; the CI of the newer commit checks this merge too`)
    return 'success'
  }

  private async verifyBase(run: TaskRun): Promise<boolean> {
    const { board } = this.options
    const { id, config, state } = run
    if (state.repos && this.repoWorkspaces(config)) {
      for (const [repo, entry] of Object.entries(state.repos)) {
        if (!entry.verify) continue
        this.deciding.add(entry.verify.sha)
        const checks = await this.verdict(entry.verify.sha, repo)
        if (checks === 'pending' || (checks === 'none' && Date.now() - Date.parse(entry.verify.since) < CHECKS_GRACE)) {
          state.parked = `merged; waits for the CI of ${repo} at ${entry.verify.sha.slice(0, 7)}`
          state.retryAt = new Date(Date.now() + LAND_WAIT).toISOString()
          await run.save()
          this.log(`task ${id}: ${state.parked}`)
          return false
        }
        if (checks === 'failure') {
          const cause = config.checks.fix_base === 'own' ? await this.causedByMerge(entry.verify, repo) : undefined
          if (cause && !cause.ours) this.notCaused(id, entry.verify.sha, repo, cause.failed)
          else {
            this.broke.add(entry.verify.sha)
            if (config.checks.fix_base === 'none') await this.leaveBroken(id, entry.verify.sha, repo)
            else this.log(`task ${id}: the CI of ${repo} failed after the merge at ${entry.verify.sha.slice(0, 7)}; the fix task of the red base repairs it`)
          }
        }
        this.deciding.delete(entry.verify.sha)
        delete entry.verify
      }
      return true
    }
    const verify = state.verify
    if (!verify) return true
    this.verifying.set(verify.sha, id)
    this.deciding.add(verify.sha)
    const checks = await this.verdict(verify.sha, undefined)
    if (checks === 'pending' || (checks === 'none' && Date.now() - Date.parse(verify.since) < CHECKS_GRACE)) {
      state.parked = `merged; waits for the CI of the base branch at ${verify.sha.slice(0, 7)}`
      state.retryAt = new Date(Date.now() + LAND_WAIT).toISOString()
      await run.save()
      this.log(`task ${id}: ${state.parked}`)
      return false
    }
    delete state.verify
    if (checks !== 'failure') {
      this.verifying.delete(verify.sha)
      this.deciding.delete(verify.sha)
      return true
    }
    const cause = config.checks.fix_base === 'own' ? await this.causedByMerge(verify, undefined) : undefined
    this.deciding.delete(verify.sha)
    if (cause && !cause.ours) {
      this.verifying.delete(verify.sha)
      this.notCaused(id, verify.sha, undefined, cause.failed)
      return true
    }
    this.log(`task ${id}: the CI of the base branch failed after the merge at ${verify.sha.slice(0, 7)}`)
    this.broke.add(verify.sha)
    if (config.checks.fix_base === 'none') {
      this.verifying.delete(verify.sha)
      await this.leaveBroken(id, verify.sha, undefined)
      return true
    }
    const names = config.stages.map((stage) => stage.name)
    const repair = config.stages.slice(names.indexOf('merge') + 1).some((stage) => stage.when === 'failure' || stage.when === 'always')
    if (repair && (state.repairs ?? 0) < config.retry.max_attempts) {
      const fix = await this.takeFix(id)
      if (fix.busy) {
        state.verify = verify
        state.retryAt = new Date(Date.now() + LAND_WAIT).toISOString()
        await run.save()
        this.log(`task ${id}: ${fix.held}; it checks again`)
        return false
      }
      if (fix.held) {
        this.verifying.delete(verify.sha)
        this.log(`task ${id}: ${fix.held}`)
        return true
      }
      state.repairs = (state.repairs ?? 0) + 1
      state.broken = verify.sha
      return true
    }
    this.verifying.delete(verify.sha)
    const text = `**The base branch CI failed after this task was merged** (commit \`${verify.sha.slice(0, 7)}\`).\n\nReply \`/fix_from: implement <notes>\` to fix it in a follow-up pull request from the latest base branch, or reply with any comment to finish the task as it is. \`<notes>\` is free text in your own words: what to change and why.`
    const comment = await board.addComment(id, agentComment('error', text))
    state.followUp = true
    state.waiting = { kind: 'error', stage: 'verify', commentId: comment.id, since: new Date().toISOString() }
    await board.setState(id, 'needs-input')
    await run.save()
    return false
  }

  private async chooseSource(run: TaskRun, comments: Comment[], waiting: WorkpadState['waiting']): Promise<boolean> {
    const { board } = this.options
    const { id, state, config } = run
    const linked = this.repoWorkspaces(config) ? [] : (await board.linkedPulls(id).catch(() => [])).filter((pull) => pull.branch !== taskBranch(id))
    const foreign = await this.trust.only(linked)
    if (foreign.length === 0) {
      state.source = BASE_SOURCE
      return true
    }
    if (waiting?.stage === SOURCE_STAGE) {
      const replies = repliesSince(comments, waiting.commentId).map((comment) => comment.body.trim())
      const choice = replies.map((text) => text.match(/^\/(continue|fresh)(?:\s+[!#]?(\d+))?/i)).filter(Boolean).at(-1)
      if (choice?.[1]?.toLowerCase() === 'fresh') {
        state.source = BASE_SOURCE
        return true
      }
      const picked = choice ? (choice[2] ? foreign.find((pull) => pull.number === choice[2]) : foreign[0]) : undefined
      if (choice) {
        if (picked) {
          state.source = picked.branch
          await board.addComment(id, agentComment('note', `The conveyor continues the work of ${picked.url} (branch \`${picked.branch}\`) in its branch \`${taskBranch(id)}\` and opens its own pull request. Close ${picked.url} when that one is merged.`))
          return true
        }
      }
    }
    const list = foreign.map((pull) => `- ${pull.url} (branch \`${pull.branch}\`${pull.draft ? ', draft' : ''})`).join('\n')
    const missing = waiting?.stage === SOURCE_STAGE ? repliesSince(comments, waiting.commentId).map((comment) => comment.body.trim().match(/^\/continue\s+[!#]?(\d+)/i)?.[1]).filter(Boolean).at(-1) : undefined
    const text = `${missing && !foreign.some((pull) => pull.number === missing) ? `There is no linked pull request ${missing}. ` : ''}**This task already has a linked pull request:**\n\n${list}\n\nThe conveyor does not start a second line of work on its own. Reply:\n\n- \`/continue\` (or \`/continue <number>\`) to continue that work: the conveyor starts its branch \`${taskBranch(id)}\` from that branch and opens its own pull request;\n- \`/fresh\` to start from the base branch and ignore it;\n- or leave the task to a human: press \`x\` on it in the control screen and choose \`d\` (draft), or close it.`
    const comment = await board.addComment(id, agentComment('questions', text))
    state.waiting = { kind: 'questions', stage: SOURCE_STAGE, commentId: comment.id, since: new Date().toISOString() }
    await board.setState(id, 'needs-input')
    await board.setStage(id, undefined)
    await run.save()
    this.log(`task ${id}: already linked to ${foreign.map((pull) => pull.url).join(', ')}; asks whether to continue it or start fresh`)
    return false
  }

  private async causedByMerge(verify: { sha: string; head?: string; before?: string }, repo: string | undefined) {
    const { board } = this.options
    const failed = await board.failedChecks(verify.sha, repo).catch(() => [])
    if (!verify.head || failed.length === 0) return { ours: true, failed }
    const passed = new Set(await board.passedChecks(verify.head, repo).catch(() => []))
    if (passed.size === 0) return { ours: true, failed }
    const before = new Set(verify.before ? await board.failedChecks(verify.before, repo).catch(() => []) : [])
    return { ours: failed.some((name) => passed.has(name) && !before.has(name)), failed }
  }

  private notCaused(id: string, sha: string, repo: string | undefined, failed: string[]) {
    this.reportedRed.add(`${repo ?? ''}@${sha}`)
    this.log(`task ${id}: the base branch CI ${repo ? `of ${repo} ` : ''}failed after the merge at ${sha.slice(0, 7)} (${failed.join(', ')}), but no job that passed in the merge request and before the merge fails; checks.fix_base is own, so the conveyor leaves it to the team`)
  }

  private async leaveBroken(id: string, sha: string, repo: string | undefined) {
    const where = repo ? `of ${repo} ` : ''
    this.log(`task ${id}: the base branch CI ${where}failed after the merge at ${sha.slice(0, 7)}; checks.fix_base is none, so the team fixes it`)
    await this.options.board.addComment(id, agentComment('note', `**The base branch CI ${where}failed after this task was merged** (commit \`${sha.slice(0, 7)}\`). \`checks.fix_base\` is \`none\`, so the conveyor does not repair it; the team fixes the base branch.`))
  }

  private async guardBase(config: Config) {
    const multi = this.repoWorkspaces(config)
    const repos = multi ? await multi.names() : undefined
    let pending = false
    for (const repo of repos ?? [undefined]) {
      const base = await this.guardRepo(repo, config)
      if (base === 'red') return
      if (base === 'pending') pending = true
    }
    if (this.baseRed && !pending) {
      this.log('the base branch CI is green again; merges continue')
      this.baseRed = undefined
    }
  }

  private async guardRepo(repo: string | undefined, config: Config): Promise<'red' | 'pending' | 'green'> {
    const { board } = this.options
    const sha = await board.baseHead(repo)
    const checks = (await board.commitChecks(sha, repo)).replace('cancelled', 'failure')
    if (checks === 'success') return 'green'
    if (checks !== 'failure') return 'pending'
    const mode = config.checks.fix_base
    if (mode === 'own' && this.deciding.has(sha)) return 'pending'
    if (mode === 'none' || (mode === 'own' && !this.broke.has(sha))) {
      const key = `${repo ?? ''}@${sha}`
      if (!this.reportedRed.has(key)) {
        this.reportedRed.add(key)
        const failed = (await board.failedChecks(sha, repo).catch(() => [])).map((name) => name.replace(/[\r\n`]/g, ' ').slice(0, 100))
        this.log(`the base branch CI ${repo ? `of ${repo} ` : ''}fails at ${sha.slice(0, 7)}${failed.length ? ` (${failed.join(', ')})` : ''}; checks.fix_base is ${mode}, so the conveyor ${mode === 'none' ? 'fixes nothing' : 'fixes only failures after its own merges'} and does not wait; add jobs that cannot pass to checks.ignore`)
      }
      return 'green'
    }
    if (this.baseRed?.sha === sha && this.baseRed.fix && (this.baseRed.repairing ? this.verifying.has(sha) : await this.stillFixes(this.baseRed.fix))) return 'red'
    const failed = (await board.failedChecks(sha, repo).catch(() => [])).map((name) => name.replace(/[\r\n`]/g, ' ').slice(0, 100))
    const owner = this.verifying.get(sha)
    let fix = await this.fixTask()
    const where = repo ? `of ${repo} ` : ''
    if (!fix && owner) {
      this.baseRed = { sha, fix: owner, failed, repairing: true }
      this.log(`the base branch CI ${where}fails at ${sha.slice(0, 7)} after the merge of task ${taskRef(owner)}; it repairs the base, and new tasks and merges wait until it is green`)
      return 'red'
    }
    if (!fix && (await this.lock(FIX_LOCK, LOCK_TTL))) {
      try {
        fix = await this.fixTask()
        if (!fix) {
          const base = await board.baseBranch(repo)
          const name = repo ? `${repo} ${base}` : base
          const body = `The CI of the base branch \`${base}\`${repo ? ` of the repository \`${repo}\`` : ''} fails at commit \`${sha}\`${failed.length ? `: ${failed.join(', ')}` : ''}.\n\nFind the cause and fix it so that every check passes on the base branch again. If the latest base branch already fixes the failure in another way, keep the base version and drop this branch's own fix for it. Other tasks of the conveyor do not merge, and no new task starts, until this task is merged and the base branch is green.\n\n${BASE_FIX}`
          const task = await board.createTask(`Fix the CI of the base branch ${name}`, body, { state: 'backlog', form: 'plan' })
          await board.setPriority(task.id, 1)
          await board.setFixing(task.id, true)
          fix = task.id
        }
      } finally {
        await board.release(FIX_LOCK)
      }
    }
    this.baseRed = { sha, failed, ...(fix ? { fix } : {}) }
    this.log(`the base branch CI ${where}fails at ${sha.slice(0, 7)}${failed.length ? ` (${failed.join(', ')})` : ''}; ${fix ? `task ${taskRef(fix)} fixes it` : 'a fix task is chosen'}, and new tasks and merges wait until it is green`)
    return 'red'
  }

  private checksMayStart(state: { checksWait?: { sha: string; since: string } }, sha: string) {
    if (state.checksWait?.sha !== sha) state.checksWait = { sha, since: new Date().toISOString() }
    return Date.now() - Date.parse(state.checksWait.since) < CHECKS_GRACE
  }

  private quotaBlock(harness: HarnessName, config: Config): string | undefined {
    const limited = this.limited.get(harness)
    if (limited && Date.parse(limited) > Date.now()) return limited
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
    const tasks = await this.trust.only(await board.listTasks(), (task) => this.taskWhere(task.id))
    const fresh = tasks.filter((task) => !task.owner && task.form !== undefined && task.priority === undefined).map((task) => task.id)
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
        signal: AbortSignal.any([AbortSignal.timeout(config.timeouts.stage), this.halt.signal]),
      })
      if (this.halt.signal.aborted) return
      this.options.usage.add(output.usage.inputTokens + output.usage.outputTokens)
      const parsed = output.result.outcome === 'done' && output.result.artifact ? parseJson(output.result.artifact.content) : undefined
      const result = triageSchema.safeParse(parsed)
      if (!result.success) {
        this.triageRetryAt = Date.now() + config.retry.max_backoff
        this.log(`triage failed: ${output.result.outcome === 'done' ? 'invalid triage result' : output.result.summary}`)
        return
      }
      const known = new Map(tasks.map((task) => [task.id, task]))
      const prioritized = new Set<string>()
      for (const entry of result.data.tasks) {
        const task = known.get(entry.id)
        if (!task) continue
        if (entry.priority !== undefined && fresh.includes(entry.id)) {
          await board.setPriority(entry.id, entry.priority)
          prioritized.add(entry.id)
        } else if (entry.priority !== undefined && entry.priority !== task.priority) {
          this.log(`triage: suggests priority ${entry.priority} for ${taskRef(entry.id)} ${task.title} (now ${task.priority ?? 'none'}); not applied, change priority:: on the board to accept it`)
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

  private commandVerdict(human: { body: string }[], changesRequested: boolean, feedback: string[], pull: PullRequest | undefined, config: Config): Verdict | undefined {
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
    if (human.some((comment) => isCommand(comment.body, 'fix')) || changesRequested) return { kind: 'fix', pull, approvers: [], feedback, from: 'plan' }
    return undefined
  }

  private async reviewRepos(id: string, config: Config, comments: Comment[], pad: Workpad, repos: Record<string, RepoPull>): Promise<Verdict> {
    const since = pad.state.waiting?.kind === 'review' || pad.state.waiting?.kind === 'error' ? pad.state.waiting.since : ''
    const pulls: { repo: string; pull: PullRequest | undefined }[] = []
    for (const repo of this.repoOrder(pad.state, Object.keys(repos))) pulls.push({ repo, pull: await this.trustedPull(id, repo) })
    const open = pulls.filter(({ pull }) => pull?.state === 'open')
    if (open.length === 0 && pulls.every(({ repo, pull }) => pull?.state === 'merged' || repos[repo]?.merged)) return { kind: 'merged', pull: undefined, approvers: [], feedback: [] }
    const latest = ({ pull }: { pull: PullRequest | undefined }) => {
      const reviews = new Map<string, PullRequest['reviews'][number]>()
      for (const review of pull?.reviews ?? []) if (review.submittedAt >= since && review.state !== 'commented') reviews.set(review.author, review)
      return [...reviews.values()]
    }
    const issue = comments.filter((comment) => !isAgentComment(comment) && comment.createdAt >= since)
    const onPulls = pulls.flatMap(({ pull }) => (pull?.comments ?? []).filter((comment) => comment.createdAt >= since))
    const human = [...issue, ...onPulls]
    const reviews = pulls.flatMap(latest)
    const feedback = [
      ...reviews.filter((review) => review.state === 'changes_requested' && review.body.trim()).map((review) => review.body),
      ...pulls.flatMap(({ repo, pull }) => (pull?.feedback ?? []).map((comment) => `${repo}: ${comment.body}`)),
      ...human.map((comment) => stripCommand(comment.body)).filter((text): text is string => Boolean(text)),
    ]
    const command = this.commandVerdict(human, reviews.some((review) => review.state === 'changes_requested'), feedback, undefined, config)
    if (command) return command
    const stale = open.find(({ repo, pull }) => pull?.headSha !== repos[repo]?.headSha)
    if (stale) return { kind: 'stale', pull: stale.pull, repo: stale.repo, approvers: [], feedback }
    const approvers = open.map((entry) =>
      [
        ...new Set([
          ...latest(entry).filter((review) => review.state === 'approved').map((review) => review.author),
          ...(entry.pull?.comments ?? []).filter((comment) => comment.createdAt >= since && isCommand(comment.body, 'approve')).map((comment) => comment.author),
        ]),
      ].filter((author) => config.review.count_own_approvals || author !== this.me),
    )
    const approved = open.length > 0 && approvers.every((list) => list.length >= config.review.approvals)
    return { kind: approved ? 'merge' : 'wait', pull: undefined, approvers: [...new Set(approvers.flat())], feedback }
  }

  private async reviewSignal(id: string, config: Config): Promise<Verdict> {
    if (config.repos) {
      const { comments, pad } = await this.workpad(id)
      const repos = pad?.state.repos
      if (pad && repos && Object.keys(repos).length > 0) return this.reviewRepos(id, config, comments, pad, repos)
    }
    const pull = await this.trustedPull(id)
    if (pull?.state === 'merged') return { kind: 'merged', pull, approvers: [], feedback: [] }
    const { comments, pad } = await this.workpad(id)
    const since = pad?.state.waiting?.kind === 'review' || pad?.state.waiting?.kind === 'error' ? pad.state.waiting.since : ''
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

    const command = this.commandVerdict(human, reviews.some((review) => review.state === 'changes_requested'), feedback, pull, config)
    if (command) return command
    if (pull?.state === 'open' && pull.headSha !== pad?.state.headSha) return { kind: 'stale', pull, approvers: [], feedback }
    const approvers = [
      ...new Set([
        ...reviews.filter((review) => review.state === 'approved').map((review) => review.author),
        ...human.filter((comment) => isCommand(comment.body, 'approve')).map((comment) => comment.author),
      ]),
    ].filter((author) => config.review.count_own_approvals || author !== this.me)
    return { kind: pull?.state === 'open' && approvers.length >= config.review.approvals ? 'merge' : 'wait', pull, approvers, feedback }
  }

  private async takeParts(run: TaskRun, parts: string[] | undefined) {
    const { state } = run
    const merged = state.parts?.slice(0, state.part ?? 0) ?? []
    if (parts) {
      state.parts = [...merged, ...parts]
      state.part = merged.length
    } else if (merged.length === 0) {
      delete state.parts
      delete state.part
    }
    await this.options.board.setPart(run.id, state.parts ? `${(state.part ?? 0) + 1}/${state.parts.length}` : undefined)
  }

  private async reviewAgain(id: string, sha: string, repo?: string, headAt?: string) {
    const { board } = this.options
    const { pad } = await this.workpad(id)
    if (!pad) return
    const entry = repo ? pad.state.repos?.[repo] : undefined
    if (entry) entry.headSha = sha
    else pad.state.headSha = sha
    pad.state.waiting = { kind: 'review', since: reviewSince(headAt) }
    await board.addComment(id, agentComment('review', changedText(sha, entry ? repo : undefined)))
    await board.updateComment(pad.id, renderWorkpad(pad.state, pad.text))
    this.log(`task ${id}: the branch changed during review, approval needed for ${sha.slice(0, 7)}`)
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
    const repos = await this.repoWorkspaces(config)?.names()
    const prompt = buildPrompt({
      ...(repos ? { repos } : {}),
      task,
      stage: stage.name,
      instructions: instructions.text,
      ...(context.gate ? { gate: context.gate } : {}),
      artifacts: context.artifacts,
      workpad: context.workpad,
      ...(context.conversation ? { conversation: context.conversation } : {}),
      ...(context.notes?.length ? { notes: context.notes } : {}),
      ...(context.split ? { split: true } : {}),
      attempt: context.attempt,
      language: config.language.docs,
      ...(context.review ? { review: context.review, reviewMode: context.reviewMode ?? 'rework' } : {}),
      ...(context.merge ? { merge: context.merge } : {}),
      ...(stage.name === 'merge' && config.transitions.merge === 'smart' ? { mergeCriteria: this.read('smart', 'merge.md') } : {}),
      ...(context.parts ? { parts: context.parts } : {}),
      ...(this.baseRed && this.baseRed.fix !== task.id
        ? {
            base: `The CI of the base branch fails at \`${this.baseRed.sha.slice(0, 7)}\`${this.baseRed.failed.length ? ` (${this.baseRed.failed.join(', ')})` : ''}, and this task did not cause it. ${this.baseRed.fix ? `Task ${taskRef(this.baseRed.fix)}` : 'A fix task'} fixes it; this task merges only after the base branch is green again. Do not fix failures that also occur on the base branch. Make the tests of your change pass, and name the failures that come from the base branch in your summary.`,
          }
        : {}),
    })

    const controller = new AbortController()
    const stop = () => controller.abort()
    context.signal.addEventListener('abort', stop, { once: true })
    let reason: string | undefined
    let session: ReturnType<typeof sessionWriter> | undefined
    const record = (write: () => void) => {
      try {
        write()
      } catch (error) {
        session = undefined
        this.log(`task ${task.id}: the session log stopped: ${(error as Error).message}`)
      }
    }
    if (config.session_logs) {
      record(() => {
        session = sessionWriter(sessionFile(this.options.home, config.board.project, task.id), context.workspace, this.options.redact ?? ((text) => redactSecrets(text)))
        session.header(`${stage.name} · ${stage.harness}${stage.model ? ` ${stage.model}` : ''} · attempt ${context.attempt + 1} · ${new Date().toISOString().slice(0, 10)}`)
      })
    }
    const { stage: stageTimeout, stall } = config.timeouts
    const deadline = setTimeout(() => {
      reason = `stage timed out after ${stageTimeout / 60_000} min`
      controller.abort()
    }, stageTimeout)
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const started = new Date().toISOString()
    this.activities.set(task.id, { stage: stage.name, startedAt: started, lastOutputAt: started })
    const arm = () => {
      const activity = this.activities.get(task.id)
      if (activity) activity.lastOutputAt = new Date().toISOString()
      if (!stall) return
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        reason = `stage stalled: no harness output or activity for ${stall / 60_000} min`
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
        onEvent: (line) => {
          arm()
          if (line && session) record(() => session?.event(line))
        },
        onQuota: (quota) => this.quotas.set(stage.harness, quota),
        skills: skills.filter((skill) => skill.source !== 'project'),
        ...(stage.sandbox ? { sandbox: stage.sandbox } : {}),
        ...(stage.network !== undefined ? { network: stage.network } : {}),
        ...(stage.permissionMode ? { permissionMode: stage.permissionMode } : {}),
      })
      return reason ? { ...output, result: failed(reason) } : output
    } finally {
      this.activities.delete(task.id)
      clearTimeout(deadline)
      clearTimeout(watchdog)
      context.signal.removeEventListener('abort', stop)
      if (!context.signal.aborted) await this.options.workspaces.runHook('after_run', context.workspace)
      const left = await this.options.leftovers?.(context.workspace, taskSlug(task.id)).catch(() => [])
      if (left?.length) this.log(`task ${task.id}: stopped what the ${stage.name} stage left running: ${left.join(', ')}`)
    }
  }

  private collectsParts(state: WorkpadState, config: Config) {
    return config.parts === 'together' && state.parts !== undefined && (state.part ?? 0) < state.parts.length - 1
  }

  private partsText(id: string, state: WorkpadState, done: number) {
    const parts = (state.parts ?? []).map((part, index) => `- [${index < done ? 'x' : ' '}] ${index + 1}. ${part}`).join('\n')
    return `Part of ${this.options.board.reference(id)}. The parts of the plan collect here; the conveyor asks for review after the last one.\n\n${parts}`
  }

  private async nextCollectedPart(run: TaskRun, initial: Task) {
    const { board, workspaces } = this.options
    const { id, config, state } = run
    const parts = state.parts ?? []
    const done = (state.part ?? 0) + 1
    const task = (await board.getTask(id)) ?? initial
    const body = this.partsText(id, state, done)
    const opened: string[] = []
    const multi = this.repoWorkspaces(config)
    try {
      if (multi) {
        state.repos ??= {}
        for (const repo of this.repoOrder(state, await multi.changed(id))) {
          if (state.repos[repo]) continue
          const pull = await board.openPullRequest(id, task.title, body, repo, true)
          state.repos[repo] = { number: pull.number, url: pull.url, headSha: pull.headSha }
          opened.push(`- \`${repo}\`: ${pull.url}`)
        }
      } else if (!state.pull && (await workspaces.ahead(id).catch(() => 1)) > 0) {
        const pull = await board.openPullRequest(id, task.title, body, undefined, true)
        state.pull = { number: pull.number, url: pull.url }
        opened.push(`- ${pull.url}`)
      }
    } catch (error) {
      state.stage = 'merge'
      await this.stopWithError(run, 'merge', `**The draft ${multi ? 'merge request' : 'pull request'} was not opened.**\n\n${publicText((error as Error).message, this.options.home)}`)
      return
    }
    if (opened.length > 0) {
      await board.addComment(id, agentComment('note', `**Draft ${multi ? 'merge requests' : 'pull request'} for all parts of this task:**\n\n${opened.join('\n')}\n\nEvery part adds its commits there. After the last part the conveyor rebases the branch, waits for the checks, and marks it ready for review.`))
    }
    for (const key of ['landing', 'mergeError', 'landAttempts', 'lastError', 'runs', 'partBase'] as const) delete state[key]
    state.attempt = 0
    state.part = done
    state.stage = config.stages[config.stages.findIndex((stage) => stage.name === 'plan') + 1]?.name ?? 'merge'
    await board.setPart(id, `${done + 1}/${parts.length}`)
    await run.save()
    this.log(`task ${id}: part ${done} of ${parts.length} done; the parts collect in one ${multi ? 'merge request per repository' : 'pull request'}, part ${done + 1} starts`)
  }

  private async stopWithError(run: TaskRun, stage: string, text: string) {
    const { board } = this.options
    const { id, config, state } = run
    this.log(`task ${id}: ${text.replace(/\*\*/g, '').split('\n').filter(Boolean).join(' ')}`)
    const comment = await board.addComment(id, agentComment('error', `${text}\n\nFix the cause, then reply with any comment to retry.\n\n${commandHelp(config)}`))
    state.attempt = 0
    state.waiting = { kind: 'error', stage, commentId: comment.id, since: new Date().toISOString() }
    await board.setState(id, 'needs-input')
    await run.save()
  }

  private async wrongProject(id: string, config: Config) {
    if (config.repos || !config.board.group) return undefined
    this.originPath ??= createRun(this.options.repo)('git', ['remote', 'get-url', 'origin']).then((result) =>
      result.code === 0 ? result.stdout.trim().replace(/\.git$/, '').replace(/^[\w.-]+@[^:/]+:|^\w+:\/\/(?:[^@/]+@)?[^/]+\//, '') : undefined,
    )
    const origin = await this.originPath
    const project = this.options.board.reference(id).replace(/#\d+$/, '')
    if (!origin || !project || origin.toLowerCase() === project.toLowerCase() || origin.toLowerCase().endsWith(`/${project.toLowerCase()}`)) return undefined
    return `the issue belongs to the project ${project}, but the conveyor works in a clone of ${origin}, so it cannot open a merge request for it. A group board with issues in several projects needs \`repos\` in config.yaml (and \`repo_paths\` in local.yaml for existing clones), so that every task gets the repositories it changes.`
  }

  private async fail(id: string, stage: Stage, state: WorkpadState, result: StageResult, config: Config, fatal: boolean) {
    state.attempt++
    state.lastError = publicText(result.summary, this.options.home)
    if (fatal) {
      const text = `**The \`${stage.name}\` stage cannot start.**\n\n${state.lastError}\n\nFix the cause, then reply with any comment to retry.\n\n${commandHelp(config)}`
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
    const text = `**The \`${stage.name}\` stage failed ${state.attempt} times.**\n\n${state.lastError}\n\nReply with any comment to retry.\n\n${commandHelp(config)}`
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
    return `**Questions from the \`${stage}\` stage:**\n\n${questions}\n\nAnswer in a comment in your own words; the stage continues with your answer.`
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
    return this.trust.only(await this.options.board.listComments(id), () => this.taskWhere(id))
  }

  private taskWhere(id: string): Where {
    return { task: id, ...(this.repoSet ? { repos: this.repoSet } : {}) }
  }

  private async trustedPull(id: string, repo?: string): Promise<PullRequest | undefined> {
    const pull = await this.options.board.pullRequest(id, repo)
    if (!pull) return undefined
    const where = () => (repo ? { repo } : { task: id })
    return { ...pull, reviews: await this.trust.only(pull.reviews, where), comments: await this.trust.only(pull.comments, where), feedback: await this.trust.only(pull.feedback, where) }
  }

  private repoWorkspaces(config: Config) {
    return config.repos ? (this.options.workspaces as RepoWorkspaces) : undefined
  }

  private repoOrder(state: WorkpadState, repos: string[]) {
    const order = state.mergeOrder ?? []
    return [...order.filter((repo) => repos.includes(repo)), ...repos.filter((repo) => !order.includes(repo)).sort()]
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

  private heldBy(id: string) {
    const fixer = this.baseRed ? (this.baseRed.fix ?? '') : this.fixer
    if (fixer === undefined || fixer === id) return undefined
    return fixer ? `task ${taskRef(fixer)} fixes the CI first` : 'the base branch CI is red; a fix task is chosen first'
  }

  private isFixTask(task: Task) {
    return task.fixing === true && !task.closed && task.state !== 'done' && onBoard(task)
  }

  private async stillFixes(id: string) {
    const task = (await this.options.board.listTasks()).find((candidate) => candidate.id === id)
    return task !== undefined && (task.state === 'done' || this.isFixTask(task))
  }

  private async fixTask() {
    for (const task of await this.options.board.listTasks()) {
      if (this.isFixTask(task) && (await this.trust.trusted(task.author, this.taskWhere(task.id)))) return task.id
    }
    return undefined
  }

  private async takeFix(id: string): Promise<{ held?: string; busy?: boolean }> {
    const held = this.heldBy(id)
    if (held) return { held }
    if (!(await this.lock(FIX_LOCK, LOCK_TTL))) return { held: 'another workstation chooses the task that fixes the CI', busy: true }
    try {
      const other = await this.fixTask()
      if (other && other !== id) {
        this.fixer = other
        return { held: `task ${taskRef(other)} fixes the CI first` }
      }
      if (!other) await this.options.board.setFixing(id, true)
      if (this.fixer !== id) this.log(`CI freeze: task ${taskRef(id)} fixes the CI; merges wait`)
      this.fixer = id
      return {}
    } finally {
      await this.options.board.release(FIX_LOCK)
    }
  }

  private pickable(task: Task, config: Config, me: string) {
    const assignee = config.pickup.assignee === 'me' ? me : config.pickup.assignee
    if (task.assignees.length > 0) return task.assignees.includes(assignee)
    return config.pickup.include_unassigned
  }

  private async higherWaiter(id: string) {
    const waiters = this.slotWaiters.filter((task) => task.id !== id && !this.running.has(task.id))
    if (waiters.length === 0 || id === this.fixer || !this.me) return undefined
    const current = await this.options.board.getTask(id)
    if (!current) return undefined
    const [first] = this.sorted([current, ...waiters], this.me)
    return first && first.id !== id && (first.priority ?? Number.MAX_SAFE_INTEGER) < (current.priority ?? Number.MAX_SAFE_INTEGER) ? first : undefined
  }

  private sorted(tasks: Task[], me: string) {
    const rank = (task: Task) => (task.id === this.fixer ? -1 : task.assignees.includes(me) ? 0 : 1)
    const started = (task: Task) => (task.state && task.state !== 'backlog' ? 0 : 1)
    return [...tasks].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        started(a) - started(b) ||
        (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.localeCompare(b.createdAt) ||
        compareIds(a.id, b.id),
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

function commandHelp(config: Config) {
  const stages = config.stages.slice(0, config.stages.findIndex((stage) => stage.name === 'merge') + 1).map((stage) => `\`${stage.name}\``).join(', ')
  return [
    'To send the task back to work with your notes, reply with one of:',
    '- `/fix <notes>`: the `plan` stage adapts the plan to your notes, then the later stages run; the branch and the pull request stay.',
    `- \`/fix_from: <stage> <notes>\`: the same from that stage (${stages}), for example \`/fix_from: implement Keep the old endpoint.\``,
    '- `/rework <notes>`: start over from `plan` on a new branch.',
    '',
    '`<notes>` is free text in your own words: what to change and why.',
  ].join('\n')
}

function reviewSince(headAt: string | undefined) {
  return headAt && Date.parse(headAt) <= Date.now() ? new Date(Date.parse(headAt)).toISOString() : new Date(Date.now() + 1).toISOString()
}

function changedText(sha: string, repo?: string) {
  return `**The ${repo ? `branch of \`${repo}\`` : 'branch'} changed to \`${sha.slice(0, 7)}\` after the review request.** Approvals and \`/approve\` ${repo ? 'on its merge request ' : ''}from before this change no longer count; approvals given after it count. Review the new commits, then approve or write \`/approve\` again if you have not yet.`
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

function teamNotes(comments: Comment[]) {
  const pad = comments.find((comment) => comment.id === findWorkpad(comments)?.id)
  const since = pad?.createdAt ?? ''
  return comments
    .filter((comment) => !isAgentComment(comment) && comment.createdAt >= since && !/^\/(approve|continue|fresh|fix|fix_from:?|rework)(\s|$)/i.test(comment.body.trim()))
    .slice(-10)
    .map((comment) => ({ author: comment.author, at: comment.createdAt.slice(0, 16).replace('T', ' '), text: comment.body.slice(0, 2000) }))
}

function isCommand(text: string, command: 'approve' | 'rework' | 'fix') {
  return new RegExp(`^/${command}(\\s|$)`, 'i').test(text.trim())
}

function stripCommand(text: string): string | undefined {
  const trimmed = text.trim()
  if (isCommand(trimmed, 'approve')) return undefined
  const match = trimmed.match(/^\/(?:rework|fix|fix_from:?\s+[a-z][a-z0-9-]*)(?:\s+|$)/i)
  return (match ? trimmed.slice(match[0].length) : trimmed).trim() || undefined
}
