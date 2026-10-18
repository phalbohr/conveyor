import { taskSlug, type Board, type TaskForm } from '../board/board.js'
import { removeSession } from '../session-log.js'
import type { Workspaces } from '../workspaces.js'
import { releaseClaim } from './release.js'
import { findWorkpad, renderWorkpad } from './workpad.js'

export type ResetForm = TaskForm | 'none'

export async function recordedForm(board: Board, id: string): Promise<TaskForm | undefined> {
  return findWorkpad(await board.listComments(id))?.state.form
}

export async function resetTask(board: Board, workspaces: Pick<Workspaces, 'remove' | 'deleteBranch'>, id: string, form?: ResetForm, session?: string, parts: 'separate' | 'together' = 'separate'): Promise<string> {
  const task = await board.getTask(id)
  if (!task) throw new Error(`task ${id} not found`)
  const me = await board.user()
  if (task.owner && task.owner !== me) throw new Error(`task ${id} is claimed by @${task.owner}; only the owner resets it`)
  const pad = findWorkpad(await board.listComments(id))
  const chosen = form === 'none' ? undefined : (form ?? pad?.state.form)
  const pull = await board.pullRequest(id)
  if (pull?.state === 'open') await board.closePullRequest(id)
  for (const [repo, entry] of Object.entries(pad?.state.repos ?? {})) if (!entry.merged) await board.closePullRequest(id, repo)
  await workspaces.remove(id)
  await workspaces.deleteBranch(id)
  if (session) removeSession(session)
  if (task.fixing) await board.setFixing(id, false)
  const kept = chosen === 'plan' && pad?.state.parts ? { parts: pad.state.parts, part: parts === 'together' ? 0 : (pad.state.part ?? 0) } : undefined
  if (pad) await board.updateComment(pad.id, renderWorkpad({ attempt: 0, ...kept }, ''))
  await board.setStage(id, undefined)
  if (pad?.state.parts) await board.setPart(id, kept ? `${kept.part + 1}/${kept.parts.length}` : undefined)
  await board.setForm(id, chosen)
  await board.setState(id, 'backlog')
  const merged = pad?.state.parts && pad.state.part && parts === 'separate' ? ` Parts 1–${pad.state.part} stay merged in the base branch.` : ''
  const resumes = kept ? ` The ${kept.parts.length} parts of the plan stay; the work starts again at part ${kept.part + 1}.` : ''
  const closed = pull?.state === 'open' ? `, closed pull request ${pull.number}` : ''
  const summary = `Reset by @${me}: stopped the work${closed}, deleted the branch conveyor/${taskSlug(id)} and the workspace, cleared the workpad; back in Backlog ${chosen ? `with form::${chosen}` : 'without a form'}.${merged}${resumes}`
  if (task.owner) await releaseClaim(board, id, summary)
  else await board.release(id)
  return summary
}
