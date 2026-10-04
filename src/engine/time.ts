const DAY = 24 * 60 * 60 * 1000

export function waitingDeadline(since: Date, waiting: { days: number; working: boolean }): Date {
  if (!waiting.working) return new Date(since.getTime() + waiting.days * DAY)
  const deadline = new Date(since)
  let remaining = waiting.days
  while (remaining > 0) {
    deadline.setDate(deadline.getDate() + 1)
    const weekday = deadline.getDay()
    if (weekday !== 0 && weekday !== 6) remaining--
  }
  return deadline
}
