import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const day = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export class UsageLedger {
  private readonly days: Record<string, number>

  constructor(private readonly file?: string) {
    this.days = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>) : {}
  }

  add(tokens: number, now = new Date()) {
    this.days[day(now)] = (this.days[day(now)] ?? 0) + tokens
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.days))
  }

  today(now = new Date()) {
    return this.days[day(now)] ?? 0
  }
}
