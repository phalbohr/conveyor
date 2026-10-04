import type { Board } from '../board/board.js'
import { agentComment, findWorkpad } from './workpad.js'

export async function releaseClaim(board: Board, id: string, reason: string) {
  await board.release(id)
  await board.setOwner(id, undefined)
  await board.addComment(id, agentComment('release', reason))
}

export async function manualRelease(board: Board, id: string, force: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const task = await board.getTask(id)
  if (!task) return { ok: false, error: `task ${id} not found` }
  if (!task.owner) return { ok: false, error: `task ${id} is not claimed` }
  const me = await board.user()
  const pad = findWorkpad(await board.listComments(id))
  if (pad?.state.private && task.owner !== me && !force) {
    return {
      ok: false,
      error: `task ${id} has private artifacts of @${task.owner}; the next owner cannot read them. Use --force to release it anyway.`,
    }
  }
  await releaseClaim(board, id, `Released manually by @${me}.`)
  return { ok: true }
}
