import { CONVEYOR_PREFIXES, TASK_STATES, boardLabels, type Board } from './board/board.js'
import type { Config } from './config.js'

export type BoardCheck = {
  missing: string[]
  unused: string[]
  field?: 'missing' | { missingOptions: string[] }
  outdated: { id: string; title: string; labels: string[] }[]
}

export async function checkBoard(board: Board, config: Config): Promise<BoardCheck> {
  const found = await board.inspect()
  const required = new Set(boardLabels(config.stages.map((stage) => stage.name)).map((label) => label.name))
  const unused = found.labels.filter((label) => CONVEYOR_PREFIXES.some((prefix) => label.startsWith(prefix)) && !required.has(label)).sort()
  const outdated = found.issues
    .map((issue) => ({ ...issue, labels: issue.labels.filter((label) => unused.includes(label)) }))
    .filter((issue) => issue.labels.length > 0)
  const options = found.field && found.field !== 'missing' ? found.field.options : undefined
  const field = found.field === 'missing' ? ('missing' as const) : options ? { missingOptions: TASK_STATES.filter((state) => !options.includes(state)) } : undefined
  return {
    missing: [...required].filter((label) => !found.labels.includes(label)).sort(),
    unused,
    ...(field && (field === 'missing' || field.missingOptions.length > 0) ? { field } : {}),
    outdated,
  }
}

export function needsAttention(check: BoardCheck) {
  return check.missing.length > 0 || check.field !== undefined || check.outdated.length > 0
}

export function boardCheckLines(check: BoardCheck): string[] {
  const lines: string[] = []
  if (check.missing.length) lines.push(`Missing labels this version uses (conveyor board update adds them): ${check.missing.join(', ')}`)
  if (check.field === 'missing') lines.push('The GitHub project has no Conveyor field (conveyor board update adds it)')
  else if (check.field) lines.push(`The Conveyor field of the GitHub project lacks the options ${check.field.missingOptions.join(', ')} (conveyor board update adds them and keeps the existing options and card values)`)
  for (const issue of check.outdated) lines.push(`#${issue.id} ${issue.title} has labels this version does not use: ${issue.labels.join(', ')}; relabel it by hand`)
  if (check.unused.length) lines.push(`Labels this version does not use (left untouched; delete them by hand if no task needs them): ${check.unused.join(', ')}`)
  return lines
}
