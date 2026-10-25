import { taskRef, type Board } from '../board/board.js'
import type { Workspaces } from '../workspaces.js'
import { agentComment, findWorkpad, renderWorkpad } from './workpad.js'

export type RestartScope = 'stage' | 'part'

export async function restartTask(board: Board, workspaces: Pick<Workspaces, 'rewind'>, id: string, scope: RestartScope, stages: string[]): Promise<string> {
  const task = await board.getTask(id)
  if (!task) throw new Error(`task ${id} not found`)
  const me = await board.user()
  if (task.owner !== me) throw new Error(`task ${id} is ${task.owner ? `claimed by @${task.owner}; only the owner restarts it` : 'not started'}`)
  const pad = findWorkpad(await board.listComments(id))
  if (!pad) throw new Error(`task ${id} has no workpad; nothing to restart`)
  const state = { ...pad.state }
  let stage: string
  let summary: string
  if (scope === 'part') {
    if (!state.parts) throw new Error(`task ${id} has no parts; restart its stage instead`)
    if (state.landing === 'success' || state.verify || state.broken || Object.values(state.repos ?? {}).some((repo) => repo.merged || repo.verify)) throw new Error(`part ${(state.part ?? 0) + 1} of task ${id} is merged already`)
    if (!state.partBase) throw new Error(`no start of part ${(state.part ?? 0) + 1} is recorded for task ${id} (it started before this version of the conveyor); restart its stage or reset the task instead`)
    await workspaces.rewind(id, state.partBase)
    stage = stages[stages.indexOf('plan') + 1] ?? 'merge'
    for (const key of ['review', 'reviewMode', 'landing', 'mergeError', 'landAttempts', 'checksWait', 'stageBase'] as const) delete state[key]
    summary = `Part ${(state.part ?? 0) + 1} of ${state.parts.length} of ${taskRef(id)} restarted by @${me}: its commits are dropped, the work starts again at stage ${stage}.`
  } else {
    const current = state.stage ?? state.waiting?.stage
    if (!current || !stages.includes(current)) throw new Error(`task ${id} runs no stage now${state.stage === 'land' ? '; it waits to merge' : ''}`)
    await workspaces.rewind(id, state.stageBase)
    stage = current
    summary = state.stageBase
      ? `Stage ${stage} of ${taskRef(id)} restarted by @${me}: what its last run left is dropped, it starts again with the current settings.`
      : `Stage ${stage} of ${taskRef(id)} restarted by @${me}: it starts again with the current settings and drops the changes it did not commit; its commits stay, because its start was not recorded.`
  }
  for (const key of ['waiting', 'retryAt', 'parked', 'lastError', 'lastResult', 'runs', 'split'] as const) delete state[key]
  state.attempt = 0
  state.stage = stage
  await board.updateComment(pad.id, renderWorkpad(state, pad.text))
  await board.setStage(id, stage)
  await board.setState(id, 'in-progress')
  await board.addComment(id, agentComment('note', summary))
  return summary
}
