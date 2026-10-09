import { syncNotice } from '../settings-sync.js'
import { undescribedNotice } from '../stage-catalog.js'
import { boardCheckLines, needsAttention, type BoardCheck } from '../board-check.js'
import type { StatusSnapshot } from '../status.js'

export type Line = { text: string; tone?: 'muted' | 'warning' | 'error' | 'ok' | 'title'; segments?: { text: string; selected?: boolean }[]; cells?: [string, string]; cellWidth?: number; selected?: boolean }
export const CELL_WIDTH = 28

const row = (left: string, right: string): Line => ({ text: `  ${left.padEnd(CELL_WIDTH - 2)}${right}`, cells: [`  ${left}`, right] })
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
const number = (value: number) => value.toLocaleString('en-US')
const percent = (value: number) => `${Math.round(value * 100)}%`

export type StatusView = { column: number; open: boolean; focus: 'columns' | 'tasks'; task: number }
export type ColumnTask = { id: string; title: string; url: string; detail: string; tone?: Line['tone']; form?: string }

export const STATUS_COLUMNS = ['backlog', 'in progress', 'needs input', 'review'] as const
export const BACKLOG = 0

export function columnTasks(status: StatusSnapshot, column: number): ColumnTask[] {
  if (column === BACKLOG) {
    return status.backlog.map((task) => ({ id: task.id, title: task.title, url: task.url, detail: task.form ? `form::${task.form}` : 'no form', ...(task.form ? { form: task.form } : {}) }))
  }
  const states = [['in-progress'], ['needs-input', 'queued'], ['review']][column - 1] ?? []
  return status.mine
    .filter((task) => states.includes(task.state))
    .map((task) => {
      const details: string[] = []
      if (task.stage) details.push(`stage::${task.stage}`)
      if (task.part) details.push(`part ${task.part}`)
      if (task.state === 'queued') details.push('answered, waits for a free slot')
      if (task.attempt > 0) details.push(`attempt ${task.attempt + 1}`)
      if (task.retryAt) details.push(`retry ${time(task.retryAt)}`)
      if (task.state === 'needs-input') details.push(task.answered ? 'answered, resumes next cycle' : `waits for your answer since ${task.waitingSince ? time(task.waitingSince) : '?'}`)
      if (task.state === 'review' && task.pullRequest) details.push(task.pullRequest)
      if (task.lastError) details.push(`last error: ${task.lastError}`)
      const tone = task.lastError ? 'error' : task.state === 'needs-input' && !task.answered ? 'warning' : undefined
      return { id: task.id, title: task.title, url: task.url, detail: details.join(' · '), ...(tone ? { tone } : {}) }
    })
}

export function statusLines(status: StatusSnapshot, here?: string, view?: StatusView): Line[] {
  const { limits } = status
  const runner = here ?? (status.runner.running ? `running (pid ${status.runner.pid})` : 'stopped')
  const lines: Line[] = [
    { text: `conveyor · ${status.project} (${status.provider}) · @${status.me} · ${runner}`, tone: 'title' },
    ...(status.settingsSync.state === 'behind' ? syncNotice(status.settingsSync).split('\n').map((text): Line => ({ text, tone: 'warning' })) : []),
    ...undescribedNotice(status.undescribed).map((text): Line => ({ text, tone: 'warning' })),
    ...(status.board && needsAttention(status.board) ? [{ text: `the board differs from what this version uses: ${boardSummary(status.board)} · [k] board check`, tone: 'warning' as const }] : []),
  ]
  const forms = [status.backlog.filter((task) => !task.form), ...(['idea', 'story', 'plan'] as const).map((form) => status.backlog.filter((task) => task.form === form))]
  const counts = [limits.running, limits.awaitingMe, limits.awaitingReview]
  const columns = STATUS_COLUMNS.map((label, index) =>
    index === BACKLOG ? `${label} ${forms.map((group) => group.length).join('|')}` : `${label} ${counts[index - 1]?.used}/${counts[index - 1]?.limit}`,
  )
  lines.push({
    text: `my board: ${columns.join(' · ')}`,
    segments: [{ text: 'my board: ' }, ...columns.flatMap((text, index) => [...(index ? [{ text: ' · ' }] : []), { text, selected: view?.column === index && view.focus === 'columns' }])],
    tone: limits.awaitingMe.used >= limits.awaitingMe.limit || limits.awaitingReview.used >= limits.awaitingReview.limit ? 'warning' : 'muted',
  })
  if (!view) {
    STATUS_COLUMNS.forEach((label, column) => {
      const tasks = columnTasks(status, column)
      lines.push({ text: `${label}:`, tone: 'title' }, ...(tasks.length ? tasks.map((task): Line => ({ text: `  #${task.id} ${task.title}${task.detail ? ` — ${task.detail}` : ''}`, ...(task.tone ? { tone: task.tone } : {}) })) : [{ text: '  none', tone: 'muted' as const }]))
    })
  }
  if (view?.open) {
    const tasks = columnTasks(status, view.column)
    if (tasks.length === 0) lines.push({ text: `  no tasks in ${STATUS_COLUMNS[view.column]}`, tone: 'muted' })
    const width = Math.max(...tasks.map((task) => task.id.length)) + 4
    tasks.forEach((task, index) => {
      const selected = view.focus === 'tasks' && view.task === index
      const left = `${selected ? '› ' : '  '}#${task.id}`
      const right = `${task.title}${task.detail ? ` — ${task.detail}` : ''}`
      lines.push({ text: `${left.padEnd(width)}${right}`, cells: [left, right], cellWidth: width, ...(selected ? { selected } : {}), ...(task.tone ? { tone: task.tone } : {}) })
    })
  }
  const blocked = [
    ...(limits.dailyTokens.limit && limits.dailyTokens.used >= limits.dailyTokens.limit ? ['the daily token limit'] : []),
    ...Object.entries(limits.subscription)
      .filter(([, quota]) => reserveReached(quota))
      .map(([harness]) => `the ${harness} subscription reserve`),
  ]
  if (blocked.length) lines.push({ text: `no new tasks: ${blocked.join(' and ')} reached · [u] usage`, tone: 'warning' })

  lines.push({ text: '' }, { text: `Team: ${status.team.unclaimed} unclaimed · ${status.team.claimedByOthers} claimed by others`, tone: 'muted' })
  return lines
}

function boardSummary(check: BoardCheck) {
  return [
    check.missing.length ? `${check.missing.length} labels missing` : '',
    check.field === 'missing' ? 'no Conveyor field' : check.field ? `${check.field.missingOptions.length} Conveyor options missing` : '',
    check.outdated.length ? `${check.outdated.length} tasks with old labels` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export function boardLines(status: StatusSnapshot): Line[] {
  const lines = status.board ? boardCheckLines(status.board) : []
  return [
    { text: 'Board check · [k] or Esc back', tone: 'title' },
    { text: 'The conveyor compares the board with the labels and fields this version uses. It never changes or deletes what exists.', tone: 'muted' },
    { text: '' },
    ...(status.board ? (lines.length ? lines.map((text): Line => ({ text: `  ${text}` })) : [{ text: '  The board has everything this version uses.', tone: 'ok' as const }]) : [{ text: '  Not checked yet; press r.', tone: 'muted' as const }]),
    ...(status.board && (status.board.missing.length || status.board.field) ? [{ text: '' }, { text: 'Enter adds the missing labels, the Conveyor field, and its missing options; existing ones and card values stay.', tone: 'title' as const }] : []),
  ]
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
    { text: 'Board panel', tone: 'title' },
    row('backlog 8|4|6|2', 'tasks of the whole board in Backlog: no form | form::idea | form::story | form::plan'),
    row('in progress 1/3', 'my tasks in this column against my limit; needs input and review the same'),
    row('at a limit', 'the conveyor takes no new tasks until one moves on; [u] shows tokens and subscription windows'),
    row('←→ Enter ↓', 'select a column, list its tasks with stage or form, move down into the tasks'),
    row('on a task', 'Enter opens its text, workpad, and comments · c comment · b browser · h harness · i form::idea on/off (backlog) · Esc back'),
    row('part::2/3', 'the plan split the story into parts, one pull request each; the story is done after the last part merges'),
    row('an opened task', 'p switches between the issue and its pull request · c comments where you are · ↑↓ scroll'),
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
    row('this screen', 'b board in the browser · k board check (add what this version needs) · s start/stop the conveyor · u usage · o log · n new · a attach · l release · e settings · r reread the board now · h or ? help · q quit'),
    row('settings', '`e` here or `conveyor settings`: the help of the current row is shown under the list; ←→ switch options; s saves after validation'),
    row('scripting', '`conveyor config list|get|set`, `conveyor config stage add|remove|move`'),
    row('agent help', '`conveyor skill install`, then ask your agent about the conveyor (skill conveyor-help)'),
  ]
}
