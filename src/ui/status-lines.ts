import { syncNotice } from '../settings-sync.js'
import { undescribedNotice } from '../stage-catalog.js'
import type { StatusSnapshot } from '../status.js'

export type Line = { text: string; tone?: 'muted' | 'warning' | 'error' | 'ok' | 'title'; segments?: { text: string; selected?: boolean }[]; cells?: [string, string] }
export const CELL_WIDTH = 28

const row = (left: string, right: string): Line => ({ text: `  ${left.padEnd(CELL_WIDTH - 2)}${right}`, cells: [`  ${left}`, right] })
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
  const blocked = [
    ...(limits.dailyTokens.limit && limits.dailyTokens.used >= limits.dailyTokens.limit ? ['the daily token limit'] : []),
    ...Object.entries(limits.subscription)
      .filter(([, quota]) => reserveReached(quota))
      .map(([harness]) => `the ${harness} subscription reserve`),
  ]
  if (blocked.length) lines.push({ text: `no new tasks: ${blocked.join(' and ')} reached · [u] usage`, tone: 'warning' })

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

export function usageLines(status: StatusSnapshot): Line[] {
  const { limits } = status
  const lines: Line[] = [
    { text: 'Usage · [u] or Esc back', tone: 'title' },
    { text: `tokens today ${number(limits.dailyTokens.used)}${limits.dailyTokens.limit ? ` / ${number(limits.dailyTokens.limit)} (limits.daily_tokens)` : ' (no daily limit)'}` },
    { text: '' },
    { text: 'Subscription windows', tone: 'title' },
  ]
  for (const [harness, quota] of Object.entries(limits.subscription)) {
    if (!quota.observedAt) {
      lines.push({
        text: quota.reports
          ? `${harness}: not seen yet; they appear after its first stage, or with limits.subscription.probe`
          : `${harness}: none; this harness does not report subscription windows`,
        tone: 'muted',
      })
      continue
    }
    const windows = [
      quota.fiveHour ? `5h ${percent(quota.fiveHour.utilization)} (reserve ${quota.fiveHourReserve}%, resets ${time(quota.fiveHour.resetsAt)})` : '',
      quota.sevenDay ? `7d ${percent(quota.sevenDay.utilization)} (reserve ${quota.sevenDayReserve}%, resets ${time(quota.sevenDay.resetsAt)})` : '',
    ].filter(Boolean)
    lines.push({ text: `${harness}: ${windows.join(' · ')} · seen ${time(quota.observedAt)}`, ...(reserveReached(quota) ? { tone: 'warning' as const } : {}) })
  }
  lines.push({ text: '' }, { text: 'A reached reserve or daily limit stops new tasks and stages of that harness until the window resets.', tone: 'muted' })
  return lines
}

function reserveReached(quota: StatusSnapshot['limits']['subscription'][string]) {
  return Boolean(
    (quota.fiveHour && quota.fiveHourReserve > 0 && quota.fiveHour.utilization * 100 >= 100 - quota.fiveHourReserve) ||
      (quota.sevenDay && quota.sevenDayReserve > 0 && quota.sevenDay.utilization * 100 >= 100 - quota.sevenDayReserve),
  )
}

export function helpLines(): Line[] {
  return [
    { text: 'conveyor help · [h] or Esc back', tone: 'title' },
    { text: 'The board holds every task. `conveyor run` takes tasks within your limits and runs their stages; you decide at the gates.' },
    { text: '' },
    { text: 'Flow', tone: 'title' },
    { text: '  idea → story → plan → implement → review → merge → done   (stages and gates come from .conveyor/config.yaml)' },
    { text: '  board columns: backlog → needs input → queued → in progress → review → done; stage:: labels show the stage' },
    { text: '' },
    { text: 'My status', tone: 'title' },
    { text: '  in progress / needs input / review: my tasks in these columns against limits.running, awaiting_me, awaiting_review;' },
    { text: '  at a limit the conveyor takes no new tasks until one moves on. ←→ select a column, Enter lists its tasks' },
    { text: '  [u] usage: tokens today and the 5h and 7d subscription windows of every harness in use, with your reserve' },
    { text: '' },
    { text: 'Your actions', tone: 'title' },
    row('answer a question', 'reply in the issue, or `conveyor attach <number>` for a live session'),
    row('new task', '`conveyor new` (live session), or an issue with conveyor::backlog and a form::idea|story|plan label'),
    row('approve a reviewed task', '`/approve` or an Approve review on the issue or the pull request; the conveyor merges after `review.approvals` people approved'),
    row('small fixes', '`/fix <notes>`, or `/fix_from: <stage> <notes>` to start later'),
    row('start over', '`/rework <notes>`'),
    row('hand a task over', '`conveyor release <number>`'),
    row('<number>', 'the issue number on the board: issues/51 → `conveyor attach 51`'),
    { text: '' },
    { text: 'Screens and commands', tone: 'title' },
    row('this screen', 's start/stop the conveyor · ←→ Enter status columns · u usage · o log · n new · a attach · l release · e settings · r refresh · h help · q quit'),
    row('settings', '`e` here or `conveyor settings`: the help of the current row is shown under the list; ←→ switch options; s saves after validation'),
    row('scripting', '`conveyor config list|get|set`, `conveyor config stage add|remove|move`'),
    row('agent help', '`conveyor skill install`, then ask your agent about the conveyor (skill conveyor-help)'),
  ]
}
