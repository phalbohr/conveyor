import { syncNotice } from '../settings-sync.js'
import { undescribedNotice } from '../stage-catalog.js'
import { boardCheckLines, needsAttention, type BoardCheck } from '../board-check.js'
import { dateTime } from './time.js'
import type { StatusSnapshot } from '../status.js'
import type { QuotaWindow } from '../harness/harness.js'
import { taskRef } from '../board/board.js'

export type Line = { text: string; tone?: 'muted' | 'warning' | 'error' | 'ok' | 'title'; segments?: { text: string; selected?: boolean; marked?: boolean; flash?: boolean }[]; cells?: [string, string]; cellWidth?: number; selected?: boolean }
export const CELL_WIDTH = 28

const row = (left: string, right: string): Line => ({ text: `  ${left.padEnd(CELL_WIDTH - 2)}${right}`, cells: [`  ${left}`, right] })
const time = dateTime
const QUIET = 2 * 60_000
const span = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
const number = (value: number) => value.toLocaleString('en-US')
const percent = (value: number) => `${Math.round(value * 100)}%`

export type StatusView = { column: number; open: boolean; focus: 'columns' | 'tasks'; task: number }
export type ColumnTask = { id: string; title: string; url: string; detail: string; tone?: Line['tone']; form?: string; released?: boolean }

export const STATUS_COLUMNS = ['backlog', 'needs input', 'queued', 'in progress', 'review'] as const
export const BACKLOG = 0

export function columnTasks(status: StatusSnapshot, column: number): ColumnTask[] {
  if (column === BACKLOG) {
    return status.backlog.map((task) =>
      task.released
        ? { id: task.id, title: task.title, url: task.url, detail: `released · resumes${task.released.stage ? ` at stage::${task.released.stage}` : ''} (conveyor::${task.released.state}) before new tasks · x resets it`, tone: 'warning' as const, released: true }
        : { id: task.id, title: task.title, url: task.url, detail: task.form ? `form::${task.form}` : 'no form', ...(task.form ? { form: task.form } : {}) },
    )
  }
  const states = [['needs-input'], ['queued'], ['in-progress'], ['review']][column - 1] ?? []
  return status.mine
    .filter((task) => states.includes(task.state))
    .map((task) => {
      const details: string[] = []
      if (task.stage) details.push(`stage::${task.stage}`)
      if (task.part) details.push(`part ${task.part}`)
      const now = Date.now()
      const quiet = task.activity ? now - Date.parse(task.activity.lastOutputAt) : 0
      if (task.activity) details.push(`● running here ${span(now - Date.parse(task.activity.startedAt))} · ${quiet < QUIET ? `active ${span(quiet)} ago` : `no activity for ${span(quiet)}`}`)
      else if (task.state === 'in-progress') {
        const heartbeat = task.heartbeat ? ` · heartbeat ${span(now - Date.parse(task.heartbeat))} ago` : ''
        if (!status.runner.running) details.push('○ not running: [s] starts the conveyor')
        else if (task.held ?? task.parked) details.push(`○ ${task.held ?? task.parked}${heartbeat}`)
        else if (status.runner.here) details.push(`○ waits for its next attempt${heartbeat}`)
        else details.push(`runs in conveyor pid ${status.runner.pid ?? '?'}${heartbeat}`)
      }
      if (task.state === 'queued') details.push(task.held ?? task.parked ?? 'waits for a free slot')
      if (task.runs && task.state !== 'needs-input') details.push(`run ${task.runs + 1}`)
      if (task.attempt > 0 && !task.activity) details.push(`attempt ${task.attempt + 1}`)
      if (task.retryAt && !task.activity) details.push(Date.parse(task.retryAt) > now ? `retry ${time(task.retryAt)}` : status.runner.running ? 'resumes next cycle' : 'resumes on start')
      if (task.state === 'needs-input') details.push(task.answered ? (task.held ? `answered, ${task.held}` : 'answered, resumes next cycle') : `waits for your answer since ${task.waitingSince ? time(task.waitingSince) : '?'}`)
      if (task.state === 'review' && task.pullRequest) details.push(task.pullRequest)
      if (task.lastError && !task.activity) details.push(`last error: ${task.lastError}`)
      const tone = task.lastError && !task.activity ? 'error' : (task.state === 'needs-input' && !task.answered) || quiet >= QUIET || (task.runs ?? 0) >= 2 ? 'warning' : task.activity ? 'ok' : undefined
      return { id: task.id, title: task.title, url: task.url, detail: details.join(' · '), ...(tone ? { tone } : {}) }
    })
}

export function arrivedColumns(before: StatusSnapshot | undefined, after: StatusSnapshot): number[] {
  if (!before) return []
  return STATUS_COLUMNS.flatMap((_label, column) => {
    const known = new Set(columnTasks(before, column).map((task) => task.id))
    return columnTasks(after, column).some((task) => !known.has(task.id)) ? [column] : []
  })
}

export function statusLines(status: StatusSnapshot, here?: string, view?: StatusView, flash: number[] = []): Line[] {
  const { limits } = status
  const runner = here ?? (status.runner.running ? `running (pid ${status.runner.pid})` : 'stopped')
  const lines: Line[] = [
    { text: `conveyor · ${status.project} (${status.provider}) · @${status.me} · ${runner}`, tone: 'title' },
    ...(status.settingsSync.state === 'behind' ? syncNotice(status.settingsSync).split('\n').map((text): Line => ({ text, tone: 'warning' })) : []),
    ...undescribedNotice(status.undescribed).map((text): Line => ({ text, tone: 'warning' })),
    ...(status.board && needsAttention(status.board) ? [{ text: `the board differs from what this version uses: ${boardSummary(status.board)} · [k] board check`, tone: 'warning' as const }] : []),
  ]
  const waiting = status.backlog.filter((task) => !task.released)
  const released = status.backlog.length - waiting.length
  const forms = [waiting.filter((task) => !task.form), ...(['idea', 'story', 'plan'] as const).map((form) => waiting.filter((task) => task.form === form))]
  const queued = status.mine.filter((task) => task.state === 'queued').length
  const counts = [`${limits.awaitingMe.used}/${limits.awaitingMe.limit}`, `${queued}`, `${limits.running.used}/${limits.running.limit}`, `${limits.awaitingReview.used}/${limits.awaitingReview.limit}`]
  const columns = STATUS_COLUMNS.map((label, index) =>
    index === BACKLOG ? `${label} ${forms.map((group) => group.length).join('|')}${released ? ` +${released} released` : ''}` : `${label} ${counts[index - 1]}`,
  )
  lines.push({
    text: `my board: ${columns.join(' · ')}`,
    segments: [{ text: 'my board: ' }, ...columns.flatMap((text, index) => [...(index ? [{ text: ' · ' }] : []), { text, selected: view?.column === index && view.focus === 'columns', marked: view?.column === index && view.focus === 'tasks', flash: flash.includes(index) }])],
    tone: limits.awaitingMe.used >= limits.awaitingMe.limit || limits.awaitingReview.used >= limits.awaitingReview.limit ? 'warning' : 'muted',
  })
  if (!view) {
    STATUS_COLUMNS.forEach((label, column) => {
      const tasks = columnTasks(status, column)
      lines.push({ text: `${label}:`, tone: 'title' }, ...(tasks.length ? tasks.map((task): Line => ({ text: `  ${taskRef(task.id)} ${task.title}${task.detail ? ` — ${task.detail}` : ''}`, ...(task.tone ? { tone: task.tone } : {}) })) : [{ text: '  none', tone: 'muted' as const }]))
    })
  }
  if (view?.open) {
    const tasks = columnTasks(status, view.column)
    if (tasks.length === 0) lines.push({ text: `  no tasks in ${STATUS_COLUMNS[view.column]}`, tone: 'muted' })
    const width = Math.max(...tasks.map((task) => task.id.length)) + 4
    tasks.forEach((task, index) => {
      const selected = view.focus === 'tasks' && view.task === index
      const left = `${selected ? '› ' : '  '}${taskRef(task.id)}`
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
  if (status.freeze) {
    const { id, title, base, owner, stage, waitingSince, answered } = status.freeze
    const waits = answered ? `answered, resumes ${status.runner.running ? 'next cycle' : 'on start'}` : waitingSince ? `waits for an answer since ${time(waitingSince)}` : undefined
    const where = [owner ? `@${owner}` : 'not claimed yet', waits ?? (stage ? `stage::${stage}` : ''), status.freeze.private ? 'private artifact' : ''].filter(Boolean).join(', ')
    const handOver = owner && owner !== status.me ? ` · stuck? \`conveyor release ${id}${status.freeze.private ? ' --force' : ''}\` hands it to another workstation` : ''
    lines.push({ text: `CI freeze: ${taskRef(id)} ${title} fixes the CI (${where}) · ${base ? 'new tasks and merges wait' : 'merges wait'}${handOver}`, tone: 'warning' })
  }

  lines.push({ text: '' }, { text: `Team: ${status.team.unclaimed} unclaimed · ${status.team.claimedByOthers} claimed by others`, tone: 'muted' })
  return lines
}

function boardSummary(check: BoardCheck) {
  return [
    check.project ? (check.project.linked.length ? 'board.github_project not set' : 'no GitHub project') : '',
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
    { text: 'Board check · [k] or [Esc] back', tone: 'title' },
    { text: 'The conveyor compares the board with the labels and fields this version uses. It never changes or deletes what exists.', tone: 'muted' },
    { text: '' },
    ...(status.board ? (lines.length ? lines.map((text): Line => ({ text: `  ${text}` })) : [{ text: '  The board has everything this version uses.', tone: 'ok' as const }]) : [{ text: '  Not checked yet; press r.', tone: 'muted' as const }]),
    ...(status.board && (status.board.missing.length || status.board.field || status.board.project) ? [{ text: '' }, { text: 'Enter sets up the GitHub project when it is missing and adds the missing labels, the Conveyor field, and its missing options; existing ones and card values stay.', tone: 'title' as const }] : []),
  ]
}

export function usageLines(status: StatusSnapshot): Line[] {
  const { limits } = status
  const lines: Line[] = [
    { text: 'Usage · [u] or [Esc] back', tone: 'title' },
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
  const reached = (window: QuotaWindow | undefined, reserve: number) =>
    window && reserve > 0 && Date.parse(window.resetsAt) > Date.now() && window.utilization * 100 >= 100 - reserve
  return Boolean(reached(quota.fiveHour, quota.fiveHourReserve) || reached(quota.sevenDay, quota.sevenDayReserve))
}

export function helpLines(): Line[] {
  return [
    { text: 'conveyor help · [?] or [Esc] back · [h] ask the harness with the conveyor-help skill', tone: 'title' },
    { text: 'The board holds every task. `conveyor run` takes tasks within your limits and runs their stages; you decide at the gates.' },
    { text: '' },
    { text: 'Flow', tone: 'title' },
    { text: '  idea → story → plan → implement → review → merge → done   (stages and gates come from .conveyor/config.yaml)' },
    { text: '  board columns: backlog → needs input → queued → in progress → review → done; stage:: labels show the stage' },
    { text: '' },
    { text: 'Board panel', tone: 'title' },
    row('backlog 8|4|6|2', 'tasks of the whole board in Backlog: no form | form::idea | form::story | form::plan'),
    row('+3 released', 'started tasks nobody owns (after release): listed first in Backlog; the conveyor resumes them at their stage before new tasks'),
    row('in progress 1/3', 'my tasks in this column against my limit; needs input and review the same'),
    row('queued 2', 'my tasks that wait for a free slot (they start before new tasks) or for their turn in the merge queue'),
    row('at a limit', 'the conveyor takes no new tasks until one moves on; [u] shows tokens and subscription windows'),
    row('CI freeze', 'one task fixes the CI (label fix::ci, on any workstation); merges wait until it is done, and while the base is red no new task starts · stuck: answer it, reset it, or hand it over with `conveyor release N` (`--force` when it has a private artifact of another member)'),
    row('←→ Enter ↓', 'select a column, list its tasks with stage or form, move down into the tasks'),
    row('● ○ in progress', '● running here with time and last harness activity: output or CPU work (yellow: quiet) · ○ waits or not running · pid N: another terminal'),
    row('s while running', 'first s: running stages finish, nothing new starts, then the conveyor stops · second s: stop at once · q twice: stop at once and quit'),
    row('live sessions', 'n, a, and h (on a task, on the main screen, and in help) use live.harness and live.model from local.yaml (settings: Personal)'),
    row('on a task', 'Enter opens its text, workpad, and comments · c comment · b browser · h harness · w watch its stage (session_logs) · x reset, close, or delete · i form::idea on/off (backlog) · Esc back'),
    row('run 3', 'the stage runs again since the last answer of a human (yellow from the third run); after retry.max_attempts runs the conveyor stops it and asks you'),
    row('part::2/3', 'the plan split the story into parts, one pull request each; the story is done after the last part merges'),
    row('an opened task', 'p switches between the issue and its pull request · c comments where you are · ↑↓ scroll · PgUp PgDn or Shift+↑↓ scroll a page'),
    { text: '' },
    { text: 'Your actions', tone: 'title' },
    row('answer a question', 'reply in the issue, or `conveyor attach <number>` for a live session'),
    row('new task', 'n: e write it in your editor (title, form, text) · i one-line idea · h shape it in a live harness session; or an issue with conveyor::backlog and a form::idea|story|plan label'),
    row('approve a reviewed task', '`/approve` or an Approve review on the issue or the pull request; the conveyor merges after `review.approvals` people approved'),
    row('small fixes', '`/fix <notes>`, or `/fix_from: <stage> <notes>` to start later'),
    row('start over', '`/rework <notes>`'),
    row('hand a task over', '`conveyor release <number>`'),
    row('start a task over', 'x on my task: stops it, closes its pull request, deletes its branch and workspace, back to Backlog as idea, story, plan, or draft; or c closes, D deletes the issue; or r restarts only its current stage, t its current part'),
    row('<number>', 'the issue number on the board: issues/51 → `conveyor attach 51`'),
    { text: '' },
    { text: 'Screens and commands', tone: 'title' },
    row('this screen', 'b board in the browser · k board check (add what this version needs) · s start/stop the conveyor · u usage · o log · n new · a attach · l release · e settings · r reread the board and start a conveyor cycle now · h or ? help · q quit'),
    row('settings', '`e` here or `conveyor settings`: the help of the current row is shown under the list; ←→ switch options; s saves after validation'),
    row('scripting', '`conveyor config list|get|set`, `conveyor config stage add|remove|move`'),
    row('skill help', '`conveyor skill install`, then ask your harness about the conveyor (skill conveyor-help)'),
  ]
}
