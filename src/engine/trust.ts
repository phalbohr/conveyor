import type { Board, Where } from '../board/board.js'

const FRESH = 10 * 60_000

export class Trust {
  private readonly writers = new Map<string, { ok: Promise<boolean>; at: number }>()

  constructor(private readonly board: Board) {}

  trusted(user: string, where: Where = {}) {
    const key = `${user}|${where.repo ?? ''}|${where.task ?? ''}`
    const known = this.writers.get(key)
    if (known && Date.now() - known.at < FRESH) return known.ok
    const ok = this.board.canWrite(user, where)
    this.writers.set(key, { ok, at: Date.now() })
    ok.catch(() => this.writers.delete(key))
    return ok
  }

  async only<T extends { author: string }>(items: T[], where: (item: T) => Where = () => ({})) {
    const trusted = await Promise.all(items.map((item) => this.trusted(item.author, where(item))))
    return items.filter((_, index) => trusted[index])
  }
}
