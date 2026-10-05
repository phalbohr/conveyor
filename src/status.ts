import type { Board, Task } from './board/board.js'
import { quotaFile, usageFile } from './commands/run.js'
import type { Config } from './config.js'
import { findWorkpad, repliesSince } from './engine/workpad.js'
import type { QuotaWindow } from './harness/harness.js'
import { runningPid } from './lock.js'
import { QuotaStore, UsageLedger } from './usage.js'

export type MyTask = {
  id: string
  title: string
  state: NonNullable<Task['state']>
  priority?: number
  stage?: string
  attempt: number
  retryAt?: string
  lastError?: string
  waitingSince?: string
  answered?: boolean
  pullRequest?: string
}

type Limit = { used: number; limit: number }

export type StatusSnapshot = {
  settings: string
  project: string
  provider: Config['board']['provider']
  me: string
  runner: { running: boolean; pid?: number }
  mine: MyTask[]
  team: { unclaimed: number; claimedByOthers: number }
  limits: {
    running: Limit
    awaitingMe: Limit
    awaitingReview: Limit
    dailyTokens: Limit
    subscription: Record<string, { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow; observedAt: string; fiveHourReserve: number; sevenDayReserve: number }>
  }
}

const NEW_STATES: Task['state'][] = ['idea', 'story', 'plan']

export async function collectStatus(options: { board: Board; config: Config; settings: string; home: string }): Promise<StatusSnapshot> {
  const { board, config, home } = options
  const project = config.board.project
  const me = await board.user()
  const tasks = await board.listTasks()
  const mine: MyTask[] = []

  for (const task of tasks.filter((candidate) => candidate.owner === me && candidate.state)) {
    const comments = await board.listComments(task.id)
    const state = findWorkpad(comments)?.state
    const entry: MyTask = { id: task.id, title: task.title, state: task.state as MyTask['state'], attempt: state?.attempt ?? 0 }
    if (task.priority !== undefined) entry.priority = task.priority
    const stage = state?.stage ?? state?.waiting?.stage
    if (stage) entry.stage = stage
    if (state?.retryAt) entry.retryAt = state.retryAt
    if (state?.lastError) entry.lastError = state.lastError
    if (state?.waiting) entry.waitingSince = state.waiting.since
    if (task.state === 'needs-input') entry.answered = repliesSince(comments, state?.waiting?.commentId).length > 0
    if (task.state === 'review') {
      const pull = await board.pullRequest(task.id)
      if (pull) entry.pullRequest = pull.url
    }
    mine.push(entry)
  }
  mine.sort((a, b) => Number(a.id) - Number(b.id))

  const pid = runningPid(home, project)
  const { subscription } = config.limits
  const readings = new QuotaStore(quotaFile(home, project)).all()
  return {
    settings: options.settings,
    project,
    provider: config.board.provider,
    me,
    runner: pid ? { running: true, pid } : { running: false },
    mine,
    team: {
      unclaimed: tasks.filter((task) => !task.owner && NEW_STATES.includes(task.state)).length,
      claimedByOthers: tasks.filter((task) => task.owner && task.owner !== me).length,
    },
    limits: {
      running: { used: mine.filter((task) => task.state === 'in-progress').length, limit: config.limits.running },
      awaitingMe: { used: mine.filter((task) => task.state === 'needs-input' && !task.answered).length, limit: config.limits.awaiting_me },
      awaitingReview: { used: mine.filter((task) => task.state === 'review').length, limit: config.limits.awaiting_review },
      dailyTokens: { used: new UsageLedger(usageFile(home, project)).today(), limit: config.limits.daily_tokens },
      subscription: Object.fromEntries(
        Object.entries(readings).map(([harness, reading]) => [
          harness,
          {
            ...reading.quota,
            observedAt: new Date(reading.observedAt).toISOString(),
            fiveHourReserve: subscription.five_hour_reserve,
            sevenDayReserve: subscription.seven_day_reserve,
          },
        ]),
      ),
    },
  }
}
