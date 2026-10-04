import { NO_USAGE, RESULT_SCHEMA, childEnv, failed, parseResult, type Harness, type HarnessOptions, type StageOutput, type StageRun } from './harness.js'
import { spawnLines } from './process.js'

type ResultEvent = {
  type: 'result'
  is_error?: boolean
  result?: string
  structured_output?: unknown
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }
}

export class ClaudeHarness implements Harness {
  constructor(private readonly options: HarnessOptions = {}) {}

  async runStage(run: StageRun): Promise<StageOutput> {
    let last: ResultEvent | undefined
    const args = [
      '-p',
      '--model', run.model,
      '--effort', run.effort,
      '--output-format', 'stream-json',
      '--verbose',
      '--json-schema', JSON.stringify(RESULT_SCHEMA),
      '--permission-mode', 'bypassPermissions',
      '--setting-sources', 'project,local',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--',
      run.prompt,
    ]
    const exit = await spawnLines(this.options.command ?? 'claude', args, {
      cwd: run.cwd,
      env: childEnv(this.options.env ?? process.env),
      ...(run.signal ? { signal: run.signal } : {}),
      onLine: (line) => {
        run.onEvent?.()
        const event = parseLine(line)
        if (event?.type === 'result') last = event as ResultEvent
      },
    })

    if (exit.aborted) return { result: failed('stage aborted'), usage: usage(last) }
    if (!last || last.is_error || exit.code !== 0) {
      return { result: failed(last?.result ?? exit.error ?? (exit.stderr.trim() || `claude exited with code ${exit.code}`)), usage: usage(last) }
    }
    return { result: parseResult(last.structured_output), usage: usage(last) }
  }
}

function usage(event: ResultEvent | undefined) {
  if (!event?.usage) return NO_USAGE
  const { input_tokens = 0, cache_creation_input_tokens = 0, cache_read_input_tokens = 0, output_tokens = 0 } = event.usage
  return { inputTokens: input_tokens + cache_creation_input_tokens + cache_read_input_tokens, outputTokens: output_tokens }
}

function parseLine(line: string): { type?: string } | undefined {
  try {
    return JSON.parse(line) as { type?: string }
  } catch {
    return undefined
  }
}
