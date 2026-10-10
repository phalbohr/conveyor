import type { Context } from '../cli.js'
import { boardCheckLines, checkBoard, type BoardCheck } from '../board-check.js'
import { loadConfig } from '../config.js'
import { setUpProject } from '../project-setup.js'
import { boardAdapter, prepare } from './run.js'

export async function boardCheckCommand(context: Context, json: boolean): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const check = await checkBoard(prepared.board, prepared.config)
  if (json) {
    context.stdout(`${JSON.stringify(check)}\n`)
    return 0
  }
  const lines = boardCheckLines(check)
  context.stdout(lines.length ? `${lines.join('\n')}\n` : 'The board has everything this version of the conveyor uses.\n')
  return 0
}

export async function applyBoardUpdate(context: Context, settings: string): Promise<{ added: string[]; synced: number; project?: string; after: BoardCheck }> {
  let loaded = loadConfig(settings)
  if (!loaded.ok) throw new Error(loaded.errors.join('; '))
  let board = boardAdapter(context, loaded.config)
  const before = await checkBoard(board, loaded.config)
  const project = await setUpProject(board, loaded.config, settings)
  if (project.number) {
    loaded = loadConfig(settings)
    if (!loaded.ok) throw new Error(loaded.errors.join('; '))
    board = boardAdapter(context, loaded.config)
  }
  const config = loaded.config
  await board.prepare(config.stages.map((stage) => stage.name))
  const synced = await board.syncMirror(await board.listTasks())
  const after = await checkBoard(board, config)
  const added = [
    ...before.missing.filter((label) => !after.missing.includes(label)),
    ...(before.field === 'missing' && after.field !== 'missing' ? ['the Conveyor field'] : []),
    ...(before.field && before.field !== 'missing' ? before.field.missingOptions.filter((option) => !(after.field && after.field !== 'missing' && after.field.missingOptions.includes(option))).map((option) => `the Conveyor option ${option}`) : []),
  ]
  return { added, synced, ...(project.message ? { project: project.message } : {}), after }
}

export async function boardUpdateCommand(context: Context, json: boolean): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const { added, synced, project, after } = await applyBoardUpdate(context, prepared.settings)
  if (json) {
    context.stdout(`${JSON.stringify({ added, synced, project, remaining: after })}\n`)
    return 0
  }
  if (project) context.stdout(`${project}\n`)
  context.stdout(added.length ? `Added: ${added.join(', ')}\n` : 'Nothing to add.\n')
  if (synced) context.stdout(`Moved ${synced} cards to the column of their conveyor:: label.\n`)
  const remaining = boardCheckLines({ ...after, missing: [] })
  if (remaining.length) context.stdout(`Left for you:\n${remaining.join('\n')}\n`)
  return 0
}
