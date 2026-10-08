import { syncNotice } from '../settings-sync.js'
import { undescribedNotice } from '../stage-catalog.js'
import type { StatusSnapshot } from '../status.js'

export type Line = { text: string; tone?: 'muted' | 'warning' | 'error' | 'ok' | 'title'; segments?: { text: string; selected?: boolean }[] }
export type StatusView = { column: number; open: boolean }

export const STATUS_COLUMNS = [
  { label: 'in progress', state: 'in-progress' },
  { label: 'needs input', state: 'needs-input' },
  { label: 'review', state: 'review' },
] as const

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
const number = (value: number) => value.toLocaleString('en-US')
const percent = (value: number) => `${Math.round(value * 100)}%`

export function statusLines(status: StatusSnapshot, here?: string, view?: StatusView): Line[] {
  const { limits } = status
  const runner = here ?? (status.runner.running ? `running (pid ${status.runner.pid})` : 'stopped')
  const lines: Line[] = [
    { text: `conveyor · ${status.project} (${status.provider}) · @${status.me} · ${runner}`, tone: 'title' },
    ...(status.settingsSync.state === 'behind' ? syncNotice(status.settingsSync).split('\n').map((text): Line => ({ text, tone: 'warning' })) : []),
    ...undescribedNotice(status.undescribed).map((text): Line => ({ text, tone: 'warning' })),
  ]
  const counts = [limits.running, limits.awaitingMe, limits.awaitingReview]
  const columns = STATUS_COLUMNS.map((column, index) => `${column.label} ${counts[index]?.used}/${counts[index]?.limit}`)
  lines.push({
    text: `my status: ${columns.join(' · ')}`,
    segments: [{ text: 'my status: ' }, ...columns.flatMap((text, index) => [...(index ? [{ text: ' · ' }] : []), { text, selected: view?.column === index }])],
    tone: limits.awaitingMe.used >= limits.awaitingMe.limit || limits.awaitingReview.used >= limits.awaitingReview.limit ? 'warning' : 'muted',
  })
  const selected = view?.open ? STATUS_COLUMNS[view.column] : undefined
  if (selected) {
    const tasks = status.mine.filter((task) => task.state === selected.state)
    if (tasks.length === 0) lines.push({ text: `  no tasks ${selected.label}`, tone: 'muted' })
    for (const task of tasks) lines.push({ text: `  #${task.id} ${task.title}${task.stage ? ` — ${task.stage}` : ''}${task.state === 'needs-input' && task.answered ? ' — answered' : ''}` })
  }
  lines.push({ text: `usage: tokens today ${number(limits.dailyTokens.used)}${limits.dailyTokens.limit ? ` / ${number(limits.dailyTokens.limit)}` : ''}`, tone: 'muted' })

  for (const [harness, quota] of Object.entries(limits.subscription)) {
    if (!quota.observedAt) {
      lines.push({
        text: quota.reports
          ? `${harness}: subscription windows not seen yet; they appear after its first stage, or with limits.subscription.probe`
          : `${harness}: no subscription windows; this harness does not report them`,
        tone: 'muted',
      })
      continue
    }
    const windows = [
      quota.fiveHour ? `5h ${percent(quota.fiveHour.utilization)} (reserve ${quota.fiveHourReserve}%, resets ${time(quota.fiveHour.resetsAt)})` : '',
      quota.sevenDay ? `7d ${percent(quota.sevenDay.utilization)} (reserve ${quota.sevenDayReserve}%, resets ${time(quota.sevenDay.resetsAt)})` : '',
    ].filter(Boolean)
    const low =
      (quota.fiveHour && quota.fiveHourReserve > 0 && quota.fiveHour.utilization * 100 >= 100 - quota.fiveHourReserve) ||
      (quota.sevenDay && quota.sevenDayReserve > 0 && quota.sevenDay.utilization * 100 >= 100 - quota.sevenDayReserve)
    lines.push({ text: `${harness}: ${windows.join(' · ')} · seen ${time(quota.observedAt)}`, tone: low ? 'warning' : 'muted' })
  }

  lines.push({ text: '' }, { text: 'My tasks', tone: 'title' })
  if (status.mine.length === 0) lines.push({ text: '  none', tone: 'muted' })
  for (const task of status.mine) {
    const details: string[] = []
    if (task.stage) details.push(task.stage)
    if (task.attempt > 0) details.push(`attempt ${task.attempt + 1}`)
    if (task.retryAt) details.push(`retry ${time(task.retryAt)}`)
    if (task.state === 'needs-input') details.push(task.answered ? 'answered, resumes next cycle' : `waiting for your answer since ${task.waitingSince ? time(task.waitingSince) : '?'}`)
    if (task.state === 'review') details.push(task.pullRequest ? `review ${task.pullRequest}` : 'review')
    if (task.lastError) details.push(`last error: ${task.lastError}`)
    const tone = task.lastError ? 'error' : task.state === 'needs-input' && !task.answered ? 'warning' : task.state === 'review' ? 'ok' : undefined
    lines.push({ text: `  #${task.id} ${task.state.padEnd(12)} ${task.title}${details.length ? ` — ${details.join(' · ')}` : ''}`, ...(tone ? { tone } : {}) })
  }

  lines.push({ text: '' }, { text: `Team: ${status.team.unclaimed} unclaimed · ${status.team.claimedByOthers} claimed by others`, tone: 'muted' })
  return lines
}

export function helpLines(): Line[] {
  return [
    { text: 'conveyor help', tone: 'title' },
    { text: 'The board holds every task. `conveyor run` takes tasks within your limits and runs their stages; you decide at the gates.' },
    { text: '' },
    { text: 'Flow', tone: 'title' },
    { text: '  idea → story → plan → implement → review → merge → done   (stages and gates come from .conveyor/config.yaml)' },
    { text: '  board columns: backlog → needs input → queued → in progress → review → done; stage:: labels show the stage' },
    { text: '' },
    { text: 'My status', tone: 'title' },
    { text: '  in progress / needs input / review: my tasks in these columns against limits.running, awaiting_me, awaiting_review;' },
    { text: '  at a limit the conveyor takes no new tasks until one moves on. ←→ select a column, Enter lists its tasks' },
    { text: '  usage: tokens today and subscription windows (5h and 7d use of each subscription, with your reserve)' },
    { text: '' },
    { text: 'Your actions', tone: 'title' },
    { text: '  answer a question         reply in the issue, or `conveyor attach <number>` for a live session' },
    { text: '  new task                  `conveyor new` (live session), or an issue with conveyor::backlog and a form::idea|story|plan label' },
    { text: '  merge a reviewed task     `/merge` or Approve   (on GitLab: Approve the MR, or `/merge` on the issue)' },
    { text: '  small fixes               `/fix <notes>`, or `/fix_from: <stage> <notes>` to start later' },
    { text: '  start over                `/rework <notes>`' },
    { text: '  hand a task over          `conveyor release <number>`' },
    { text: '  <number>                  the issue number on the board: issues/51 → `conveyor attach 51`' },
    { text: '' },
    { text: 'Screens and commands', tone: 'title' },
    { text: '  this screen               c start/stop the conveyor · n new · a attach · l release · s settings · r refresh · h help · q quit' },
    { text: '  settings                  `conveyor settings`: every row shows what it does; ←→ switch options; s saves after validation' },
    { text: '  scripting                 `conveyor config list|get|set`, `conveyor config stage add|remove|move`' },
    { text: '  agent help                `conveyor skill install`, then ask your agent about the conveyor (skill conveyor-help)' },
  ]
}
