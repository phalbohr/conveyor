import type { Board, TaskForm } from '../board/board.js'
import { removeSession } from '../session-log.js'
import type { Workspaces } from '../workspaces.js'
import { releaseClaim } from './release.js'
import { findWorkpad, renderWorkpad } from './workpad.js'

export type ResetForm = TaskForm | 'none'

export async function recordedForm(board: Board, id: string): Promise<TaskForm | undefined> {
  return findWorkpad(await board.listComments(id))?.state.form
}

export async function resetTask(board: Board, workspaces: Pick<Workspaces, 'remove' | 'deleteBranch'>, id: string, form?: ResetForm, session?: string): Promise<string> {
  const task = await board.getTask(id)
  if (!task) throw new Error(`task ${id} not found`)
  const me = await board.user()
  if (task.owner && task.owner !== me) throw new Error(`task ${id} is claimed by @${task.owner}; only the owner resets it`)
  const pad = findWorkpad(await board.listComments(id))
  const chosen = form === 'none' ? undefined : (form ?? pad?.state.form)
  const pull = await board.pullRequest(id)
  if (pull?.state === 'open') await board.closePullRequest(id)
  await workspaces.remove(id)
  await workspaces.deleteBranch(id)
  if (session) removeSession(session)
  if (pad) await board.updateComment(pad.id, renderWorkpad({ attempt: 0 }, ''))
  await board.setStage(id, undefined)
  if (pad?.state.parts) await board.setPart(id, undefined)
  await board.setForm(id, chosen)
  await board.setState(id, 'backlog')
  const merged = pad?.state.parts && pad.state.part ? ` Parts 1–${pad.state.part} stay merged in the base branch.` : ''
  const closed = pull?.state === 'open' ? `, closed pull request ${pull.number}` : ''
  const summary = `Reset by @${me}: stopped the work${closed}, deleted the branch conveyor/${id} and the workspace, cleared the workpad; back in Backlog ${chosen ? `with form::${chosen}` : 'without a form'}.${merged}`
  if (task.owner) await releaseClaim(board, id, summary)
  else await board.release(id)
  return summary
}
