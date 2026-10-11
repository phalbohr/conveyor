import { describe, expect, it } from 'vitest'
import { clock, dateTime } from '../src/ui/time.js'

describe('time formats', () => {
  it('shows dates as day.month. and a 24-hour clock', () => {
    const date = new Date(2026, 9, 11, 18, 24, 5)
    expect(dateTime(date.toISOString())).toBe('11.10. 18:24')
    expect(clock(date)).toBe('18:24:05')
  })
})
