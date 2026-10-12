import type { Context } from '../cli.js'
import { readSession, sessionFile } from '../session-log.js'
import { prepare } from './run.js'

export async function watchCommand(context: Context, id: string, follow: boolean, signal?: AbortSignal): Promise<number> {
  const prepared = prepare(context)
  if (!prepared) return 1
  const file = sessionFile(context.home, prepared.config.board.project, id)
  let printed = readSession(file)
  if (printed.length === 0 && !prepared.config.session_logs) {
    context.stderr('Session logs are off. Turn them on with `conveyor config set session_logs true` (personal setting); stages that start after that are recorded.\n')
    return 1
  }
  if (printed.length === 0) context.stdout(`Nothing recorded yet for #${id}: the next stage of the task writes to ${file}.\n`)
  for (const line of printed) context.stdout(`${line}\n`)
  if (!follow) return 0
  const stop = signal ?? abortOnInterrupt()
  while (!stop.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const lines = readSession(file)
    for (const line of lines.length >= printed.length ? lines.slice(printed.length) : lines) context.stdout(`${line}\n`)
    printed = lines
  }
  return 0
}

function abortOnInterrupt() {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  return controller.signal
}
