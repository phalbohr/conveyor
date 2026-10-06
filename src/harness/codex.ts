import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_USAGE, RESULT_SCHEMA, childEnv, failed, parseResult, type Harness, type HarnessOptions, type StageOutput, type StageRun, type Usage } from './harness.js'
import { spawnLines } from './process.js'

type CodexEvent = {
  type?: string
  item?: { type?: string; text?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
  message?: string
}

export class CodexHarness implements Harness {
  constructor(private readonly options: HarnessOptions = {}) {}

  async runStage(run: StageRun): Promise<StageOutput> {
    const dir = mkdtempSync(join(tmpdir(), 'conveyor-codex-'))
    const schema = join(dir, 'result.schema.json')
    writeFileSync(schema, JSON.stringify(RESULT_SCHEMA))

    let message: string | undefined
    let tokens: Usage = NO_USAGE
    let error: string | undefined
    const args = [
      'exec',
      '-m', run.model,
      '-c', `model_reasoning_effort="${run.effort}"`,
      ...(run.sandbox === 'full-access'
        ? ['--sandbox', 'danger-full-access']
        : ['--sandbox', 'workspace-write', '-c', `sandbox_workspace_write.network_access=${run.network ?? false}`]),
      '--skip-git-repo-check',
      '--ephemeral',
      '--json',
      '--output-schema', schema,
      '--',
      run.prompt,
    ]
    try {
      const exit = await spawnLines(this.options.command ?? 'codex', args, {
        cwd: run.cwd,
        env: childEnv(this.options.env ?? process.env),
        ...(run.signal ? { signal: run.signal } : {}),
        onLine: (line) => {
          run.onEvent?.()
          const event = parseLine(line)
          if (event?.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text
          if (event?.type === 'turn.completed' && event.usage) {
            tokens = { inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 }
          }
          if (event?.type === 'turn.failed' || event?.type === 'error') error = event.error?.message ?? event.message
        },
      })

      if (exit.aborted) return { result: failed('stage aborted'), usage: tokens }
      if (error || exit.code !== 0 || message === undefined) {
        return { result: failed(error ?? exit.error ?? (exit.stderr.trim() || `codex exited with code ${exit.code}`)), usage: tokens }
      }
      return { result: parseResult(parseJson(message)), usage: tokens }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function parseLine(line: string): CodexEvent | undefined {
  try {
    return JSON.parse(line) as CodexEvent
  } catch {
    return undefined
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
