import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Board } from '../src/board/board.js'
import { main, type Context, type Interact } from '../src/cli.js'
import type { ClaudeModel } from '../src/models.js'

export type Responses = Record<string, { code: number; stdout?: string }>

export function tempDir(prefix = 'conveyor-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function runCli(
  argv: string[],
  options: Partial<Omit<Context, 'run' | 'interact' | 'boardFor'>> & { responses?: Responses; board?: Board; interact?: Interact } = {},
) {
  let stdout = ''
  let stderr = ''
  const calls: string[] = []
  const context: Context = {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    cwd: options.cwd ?? tempDir(),
    home: options.home ?? tempDir('conveyor-home-'),
    interactive: options.interactive ?? false,
    interact: options.interact ?? (async () => 0),
    claudeModels: async () => CLAUDE_MODELS,
    ...(options.board ? { boardFor: () => options.board as Board } : {}),
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

export const CLAUDE_MODELS: ClaudeModel[] = [
  { value: 'default', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Default (recommended)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
]
