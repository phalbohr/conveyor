import type { Board, Task } from './board/board.js'
import { harnessesInUse } from './commands/models.js'
import { quotaFile, usageFile } from './commands/run.js'
import type { Config } from './config.js'
import { findWorkpad, repliesSince } from './engine/workpad.js'
import type { QuotaWindow } from './harness/harness.js'
import { runningPid } from './lock.js'
import { BASE_FIX, type Activity } from './engine/engine.js'
import { checkSettingsSync, type SettingsSync } from './settings-sync.js'
import { undescribedStages } from './stage-catalog.js'
import { QuotaStore, UsageLedger } from './usage.js'
import { checkBoard, type BoardCheck } from './board-check.js'

export type MyTask = {
  id: string
  title: string
  url: string
  state: NonNullable<Task['state']>
  priority?: number
  stage?: string
  attempt: number
  retryAt?: string
  lastError?: string
  waitingSince?: string
  answered?: boolean
  pullRequest?: string
  part?: string
  heartbeat?: string
  parked?: string
  held?: string
  activity?: Activity
}

export type BacklogTask = { id: string; title: string; url: string; form?: NonNullable<Task['form']>; priority?: number; released?: { state: NonNullable<Task['state']>; stage?: string } }

type Limit = { used: number; limit: number }

export type Freeze = { id: string; title: string; base: boolean; owner?: string; stage?: string; waitingSince?: string; private?: boolean }

export type StatusSnapshot = {
  settings: string
  project: string
  provider: Config['board']['provider']
  me: string
  runner: { running: boolean; pid?: number; here?: boolean }
  settingsSync: SettingsSync
  board?: BoardCheck
  undescribed: string[]
  mine: MyTask[]
  freeze?: Freeze
  backlog: BacklogTask[]
  team: { unclaimed: number; claimedByOthers: number }
  limits: {
    running: Limit
    awaitingMe: Limit
    awaitingReview: Limit
    dailyTokens: Limit
    subscription: Record<string, { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow; observedAt?: string; reports: boolean; fiveHourReserve: number; sevenDayReserve: number }>
  }
}

const QUOTA_HARNESSES = ['claude', 'codex']
const FETCH_EVERY = 5 * 60_000
let lastFetch = 0
let boardCheck: BoardCheck | undefined

export function forgetBoardCheck() {
  lastFetch = 0
}

export async function collectStatus(options: { board: Board; config: Config; settings: string; home: string }): Promise<StatusSnapshot> {
  const { board, config, home } = options
  const project = config.board.project
  const me = await board.user()
  const tasks = await board.listTasks()
  const mine: MyTask[] = []
  let freeze: Freeze | undefined
  for (const task of tasks) {
    if (!task.fixing || task.closed || task.state === 'done' || !(await board.canWrite(task.author))) continue
    const pad = findWorkpad(await board.listComments(task.id))?.state
    const waiting = task.state === 'needs-input' ? pad?.waiting?.since : undefined
    freeze = {
      id: task.id,
      title: task.title,
      base: task.body.includes(BASE_FIX),
      ...(task.owner ? { owner: task.owner } : {}),
      ...(task.stage ? { stage: task.stage } : {}),
      ...(waiting ? { waitingSince: waiting } : {}),
      ...(pad?.private ? { private: true } : {}),
    }
    break
  }
  const fixer = freeze?.id

  for (const task of tasks.filter((candidate) => candidate.owner === me && candidate.state)) {
    const comments = await board.listComments(task.id)
    const state = findWorkpad(comments)?.state
    const entry: MyTask = { id: task.id, title: task.title, url: task.url, state: task.state as MyTask['state'], attempt: state?.attempt ?? 0 }
    if (task.priority !== undefined) entry.priority = task.priority
    const stage = state?.stage ?? state?.waiting?.stage
    if (stage) entry.stage = stage
    if (state?.parts) entry.part = `${(state.part ?? 0) + 1}/${state.parts.length}`
    if (state?.retryAt) entry.retryAt = state.retryAt
    if (state?.heartbeat) entry.heartbeat = state.heartbeat
    if (state?.lastError) entry.lastError = state.lastError
    if (state?.parked) entry.parked = state.parked
    if (state?.waiting) entry.waitingSince = state.waiting.since
    if (task.state === 'needs-input') entry.answered = repliesSince(comments, state?.waiting?.commentId).length > 0
    if (task.state === 'review') {
      const pull = await board.pullRequest(task.id)
      if (pull) entry.pullRequest = pull.url
    }
    mine.push(entry)
  }
  for (const entry of mine) if (fixer && entry.id !== fixer && (entry.stage === 'merge' || entry.stage === 'land') && (entry.state === 'in-progress' || entry.state === 'queued' || entry.answered)) entry.held = `waits: task #${fixer} fixes the CI first`
  mine.sort((a, b) => Number(a.id) - Number(b.id))
  const backlog = tasks
    .filter((task) => !task.owner && task.state !== 'done' && (task.state !== undefined || task.form !== undefined))
    .map(
      (task): BacklogTask => ({
        id: task.id,
        title: task.title,
        url: task.url,
        ...(task.form ? { form: task.form } : {}),
        ...(task.priority !== undefined ? { priority: task.priority } : {}),
        ...(task.state && task.state !== 'backlog' ? { released: { state: task.state, ...(task.stage ? { stage: task.stage } : {}) } } : {}),
      }),
    )
    .sort((a, b) => Number(!a.released) - Number(!b.released) || (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || Number(a.id) - Number(b.id))

  const pid = runningPid(home, project)
  const fetch = Date.now() - lastFetch >= FETCH_EVERY
  if (fetch) lastFetch = Date.now()
  const settingsSync = await checkSettingsSync(options.settings, { fetch, base: await board.baseBranch().catch(() => undefined) })
  if (fetch) boardCheck = await checkBoard(board, config).catch(() => boardCheck)
  const { subscription } = config.limits
  const readings = new QuotaStore(quotaFile(home, project)).all()
  return {
    settings: options.settings,
    project,
    provider: config.board.provider,
    me,
    runner: pid ? { running: true, pid } : { running: false },
    settingsSync,
    ...(freeze ? { freeze } : {}),
    ...(boardCheck ? { board: boardCheck } : {}),
    undescribed: undescribedStages(options.settings, config),
    mine,
    backlog,
    team: {
      unclaimed: tasks.filter((task) => !task.owner && task.form !== undefined).length,
      claimedByOthers: tasks.filter((task) => task.owner && task.owner !== me).length,
    },
    limits: {
      running: { used: mine.filter((task) => task.state === 'in-progress').length, limit: config.limits.running },
      awaitingMe: { used: mine.filter((task) => task.state === 'needs-input' && !task.answered).length, limit: config.limits.awaiting_me },
      awaitingReview: { used: mine.filter((task) => task.state === 'review').length, limit: config.limits.awaiting_review },
      dailyTokens: { used: new UsageLedger(usageFile(home, project)).today(), limit: config.limits.daily_tokens },
      subscription: Object.fromEntries(
        [...new Set([...harnessesInUse(config), ...Object.keys(readings)])].map((harness) => {
          const reading = readings[harness]
          return [
            harness,
            {
              ...reading?.quota,
              ...(reading ? { observedAt: new Date(reading.observedAt).toISOString() } : {}),
              reports: QUOTA_HARNESSES.includes(harness),
              fiveHourReserve: subscription.five_hour_reserve,
              sevenDayReserve: subscription.seven_day_reserve,
            },
          ]
        }),
      ),
    },
  }
}
