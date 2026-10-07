import type { Board } from '../board/board.js'

const FRESH = 10 * 60_000

export class Trust {
  private readonly writers = new Map<string, { ok: Promise<boolean>; at: number }>()

  constructor(private readonly board: Board) {}

  trusted(user: string) {
    const known = this.writers.get(user)
    if (known && Date.now() - known.at < FRESH) return known.ok
    const ok = this.board.canWrite(user)
    this.writers.set(user, { ok, at: Date.now() })
    ok.catch(() => this.writers.delete(user))
    return ok
  }

  async only<T extends { author: string }>(items: T[]) {
    const trusted = await Promise.all(items.map((item) => this.trusted(item.author)))
    return items.filter((_, index) => trusted[index])
  }
}
