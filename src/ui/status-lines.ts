import type { StatusSnapshot } from '../status.js'

export type Line = { text: string; tone?: 'muted' | 'warning' | 'error' | 'ok' | 'title' }

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
const number = (value: number) => value.toLocaleString('en-US')
const percent = (value: number) => `${Math.round(value * 100)}%`

export function statusLines(status: StatusSnapshot): Line[] {
  const { limits } = status
  const runner = status.runner.running ? `running (pid ${status.runner.pid})` : 'stopped'
  const lines: Line[] = [
    { text: `conveyor · ${status.project} (${status.provider}) · @${status.me} · ${runner}`, tone: 'title' },
    {
      text: [
        `running ${limits.running.used}/${limits.running.limit}`,
        `waiting for me ${limits.awaitingMe.used}/${limits.awaitingMe.limit}`,
        `review ${limits.awaitingReview.used}/${limits.awaitingReview.limit}`,
        `tokens today ${number(limits.dailyTokens.used)}${limits.dailyTokens.limit ? ` / ${number(limits.dailyTokens.limit)}` : ''}`,
      ].join(' · '),
      tone: limits.awaitingMe.used >= limits.awaitingMe.limit || limits.awaitingReview.used >= limits.awaitingReview.limit ? 'warning' : 'muted',
    },
  ]

  for (const [harness, quota] of Object.entries(limits.subscription)) {
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
