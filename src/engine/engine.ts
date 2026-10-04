import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Board, Comment, Task } from '../board/board.js'
import type { Config, Harness as HarnessName, LoadResult, Stage } from '../config.js'
import type { Harness, StageOutput, StageResult } from '../harness/harness.js'
import { NO_USAGE, failed } from '../harness/harness.js'
import type { Workspaces } from '../workspaces.js'
import { Artifacts } from './artifacts.js'
import { buildPrompt, type GateMode } from './prompt.js'
import { waitingDeadline } from './time.js'
import {
  agentComment,
  commentText,
  findWorkpad,
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
  home: string
  loadConfig: () => LoadResult
  log?: (message: string) => void
}

type Running = { controller: AbortController; promise: Promise<void> }

type StageContext = {
  workspace: string
  artifacts: Record<string, string>
  workpad: string
  gate: { mode: GateMode; criteria: string } | undefined
  conversation: { request: string; replies: string[]; approval: boolean } | undefined
  attempt: number
  signal: AbortSignal
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
  private me?: string

  constructor(private readonly options: EngineOptions) {}

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

    const resumable: Task[] = []
    const fresh: Task[] = []
    let awaitingMe = 0
    let awaitingReview = 0
    const now = Date.now()

    for (const listed of await board.listTasks()) {
      if (this.running.has(listed.id)) continue
      const task = (await this.releaseIfExpired(listed, me, config, now)) ? withoutOwner(listed) : listed
      if (task.owner && task.owner !== me) continue
      const owned = task.owner === me
      switch (task.state) {
        case 'review':
          if (owned) awaitingReview++
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

    if (waiting > 0 || awaitingMe >= config.limits.awaiting_me || awaitingReview >= config.limits.awaiting_review) return

    for (const task of this.sorted(fresh, me)) {
      if (slots <= 0) break
      if (!(await board.claim(task.id))) continue
      await board.setOwner(task.id, me)
      this.start(task, config)
      slots--
    }
  }

  async idle() {
    while (this.running.size > 0) await Promise.all([...this.running.values()].map((running) => running.promise))
  }

  async release(id: string, reason: string) {
    const running = this.running.get(id)
    running?.controller.abort()
    await running?.promise
    await this.options.board.release(id)
    await this.options.board.setOwner(id, undefined)
    await this.options.board.addComment(id, agentComment('release', reason))
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
        void running.promise.then(() => this.options.workspaces.remove(id)).catch((error: unknown) => this.log(`task ${id}: ${(error as Error).message}`))
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
    let comments = await board.listComments(id)
    const pad = findWorkpad(comments)
    const state: WorkpadState = { attempt: 0, ...pad?.state }
    const stages = this.stagesToRun(initial, state, config)
    const approvalStage = state.waiting?.kind === 'approval' ? state.waiting.stage : undefined
    let conversation = state.waiting && state.waiting.kind !== 'review' ? this.conversation(comments, state.waiting) : undefined
    delete state.waiting
    delete state.retryAt
    state.private = Object.values(config.artifacts).some((artifact) => artifact.store === 'path')

    let workpadId = pad?.id
    let workpadText = pad?.text ?? ''
    const save = async () => {
      state.heartbeat = new Date().toISOString()
      const body = renderWorkpad(state, workpadText)
      if (workpadId) await board.updateComment(workpadId, body)
      else workpadId = (await board.addComment(id, body)).id
    }

    await board.setState(id, 'in-progress')
    await save()
    const workspace = await workspaces.prepare(id)
    const artifacts = new Artifacts(board, workspaces, config, this.options.home)

    for (const stage of stages) {
      if (signal.aborted) return
      state.stage = stage.name
      await save()
      const task = (await board.getTask(id)) ?? initial
      comments = await board.listComments(id)
      const gate = this.gate(stage, config)
      const heartbeat = setInterval(() => void save().catch(() => undefined), config.timeouts.heartbeat / 3)
      let output: StageOutput
      try {
        output = await this.runStage(task, stage, config, {
          workspace: workspace.path,
          artifacts: artifacts.read(task, comments, workspace.path),
          workpad: workpadText,
          gate,
          conversation,
          attempt: state.attempt,
          signal,
        })
      } finally {
        clearInterval(heartbeat)
      }
      if (signal.aborted) return
      conversation = undefined
      await workspaces.push(id).catch((error: unknown) => this.log(`task ${id}: push failed: ${(error as Error).message}`))

      let result = output.result
      if (result.workpad) workpadText = result.workpad
      if (result.outcome === 'done' && gate?.mode === 'interactive' && approvalStage !== stage.name) result = { ...result, outcome: 'approval' }
      if (result.outcome === 'approval' && gate?.mode === 'autonomous') result = { ...result, outcome: 'done' }
      if (result.artifact && result.outcome !== 'failed') {
        const kind = GATES[stage.name] ? stage.name : result.artifact.kind
        await artifacts.store(task, kind, result.artifact.content, comments)
      }

      if (result.outcome === 'done') {
        state.attempt = 0
        delete state.lastError
        continue
      }
      if (result.outcome === 'failed') {
        await this.fail(id, stage, state, result, config)
        await save()
        return
      }
      const kind = result.outcome === 'approval' ? 'approval' : 'questions'
      const comment = await board.addComment(id, agentComment(kind, this.request(stage.name, result)))
      state.attempt = 0
      delete state.lastError
      state.waiting = { kind, stage: stage.name, commentId: comment.id, since: new Date().toISOString() }
      await board.setState(id, 'needs-input')
      await save()
      return
    }

    delete state.stage
    state.attempt = 0
    state.waiting = { kind: 'review', since: new Date().toISOString() }
    await board.setState(id, 'review')
    await save()
  }

  private async runStage(task: Task, stage: Stage, config: Config, context: StageContext): Promise<StageOutput> {
    const harness = this.options.harnesses[stage.harness]
    if (!harness) return { result: failed(`harness ${stage.harness} is not available`), usage: NO_USAGE }
    try {
      await this.options.workspaces.runHook('before_run', context.workspace)
    } catch (error) {
      return { result: failed((error as Error).message), usage: NO_USAGE }
    }
    const prompt = buildPrompt({
      task,
      stage: stage.name,
      instructions: this.read('stages', `${stage.name}.md`),
      ...(context.gate ? { gate: context.gate } : {}),
      artifacts: context.artifacts,
      workpad: context.workpad,
      ...(context.conversation ? { conversation: context.conversation } : {}),
      attempt: context.attempt,
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
      })
      return reason ? { ...output, result: failed(reason) } : output
    } finally {
      clearTimeout(deadline)
      clearTimeout(watchdog)
      context.signal.removeEventListener('abort', stop)
      if (!context.signal.aborted) await this.options.workspaces.runHook('after_run', context.workspace)
    }
  }

  private async fail(id: string, stage: Stage, state: WorkpadState, result: StageResult, config: Config) {
    state.attempt++
    state.lastError = result.summary
    if (state.attempt < config.retry.max_attempts) {
      const delay = Math.min(10_000 * 2 ** (state.attempt - 1), config.retry.max_backoff)
      state.retryAt = new Date(Date.now() + delay).toISOString()
      return
    }
    const text = `**The \`${stage.name}\` stage failed ${state.attempt} times.**\n\n${result.summary}\n\nReply in a comment to retry.`
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

  private stagesToRun(task: Task, state: WorkpadState, config: Config): Stage[] {
    const names = config.stages.map((stage) => stage.name)
    const start = state.stage ?? (task.state === 'idea' ? 'story' : task.state === 'story' ? 'plan' : names[names.indexOf('plan') + 1])
    return config.stages.slice(names.indexOf(start ?? 'merge'), names.indexOf('merge') + 1)
  }

  private gate(stage: Stage, config: Config) {
    const gate = GATES[stage.name]
    if (!gate) return undefined
    return { mode: config.transitions[gate.transition], criteria: this.read('smart', `${gate.criteria}.md`) }
  }

  private async workpad(id: string): Promise<{ comments: Comment[]; pad: Workpad | undefined }> {
    const comments = await this.options.board.listComments(id)
    return { comments, pad: findWorkpad(comments) }
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
