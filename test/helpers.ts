import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, type Context } from '../src/cli.js'

export type Responses = Record<string, { code: number; stdout?: string }>

export function tempDir(prefix = 'conveyor-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function runCli(argv: string[], options: Partial<Omit<Context, 'run'>> & { responses?: Responses } = {}) {
  let stdout = ''
  let stderr = ''
  const calls: string[] = []
  const context: Context = {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    cwd: options.cwd ?? tempDir(),
    home: options.home ?? tempDir('conveyor-home-'),
    interactive: options.interactive ?? false,
    run: async (command, args) => {
      const call = [command, ...args].join(' ')
      calls.push(call)
      const response = options.responses?.[call] ?? { code: 0 }
      return { code: response.code, stdout: response.stdout ?? '', stderr: '' }
    },
  }
  const code = await main(argv, context)
  return { code, stdout, stderr, calls, context }
}
