import type { Context } from '../cli.js'
import { boardCheckLines, checkBoard } from '../board-check.js'
import { prepare } from './run.js'

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

export async function boardUpdateCommand(context: Context, json: boolean): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const { board, config } = prepared
  const before = await checkBoard(board, config)
  await board.prepare(config.stages.map((stage) => stage.name))
  const after = await checkBoard(board, config)
  const added = [...before.missing.filter((label) => !after.missing.includes(label)), ...(before.field === 'missing' && after.field !== 'missing' ? ['the Conveyor field'] : [])]
  if (json) {
    context.stdout(`${JSON.stringify({ added, remaining: after })}\n`)
    return 0
  }
  context.stdout(added.length ? `Added: ${added.join(', ')}\n` : 'Nothing to add.\n')
  const remaining = boardCheckLines({ ...after, missing: [] })
  if (remaining.length) context.stdout(`Left for you:\n${remaining.join('\n')}\n`)
  return 0
}
