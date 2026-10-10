import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_USAGE, RESULT_SCHEMA, childEnv, failed, parseResult, type Harness, type HarnessOptions, type Quota, type QuotaWindow, type StageOutput, type StageRun, type Usage } from './harness.js'
import { spawnLines } from './process.js'

type CodexEvent = {
  type?: string
  item?: { type?: string; text?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
  message?: string
  thread_id?: string
}

type CodexWindow = { used_percent?: number; window_minutes?: number; resets_at?: number }

const FIVE_HOURS = 300
const SEVEN_DAYS = 10_080
const DAY = 86_400_000

export class CodexHarness implements Harness {
  constructor(private readonly options: HarnessOptions = {}) {}

  async probeQuota(cwd: string): Promise<Quota | undefined> {
    const output = await this.runStage({ prompt: 'Reply with the word ok.', model: 'gpt-6-luna', effort: 'low', cwd })
    return output.quota
  }

  async runStage(run: StageRun): Promise<StageOutput> {
    const dir = mkdtempSync(join(tmpdir(), 'conveyor-codex-'))
    const schema = join(dir, 'result.schema.json')
    writeFileSync(schema, JSON.stringify(RESULT_SCHEMA))

    let message: string | undefined
    let tokens: Usage = NO_USAGE
    let error: string | undefined
    let thread: string | undefined
    const args = [
      'exec',
      ...(run.model ? ['-m', run.model] : []),
      '-c', `model_reasoning_effort="${run.effort}"`,
      ...(run.sandbox === 'full-access'
        ? ['--sandbox', 'danger-full-access']
        : ['--sandbox', 'workspace-write', '-c', `sandbox_workspace_write.network_access=${run.network ?? false}`]),
      '--skip-git-repo-check',
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
          if (event?.type === 'thread.started') thread = event.thread_id
          if (event?.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text
          if (event?.type === 'turn.completed' && event.usage) {
            tokens = { inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 }
          }
          if (event?.type === 'turn.failed' || event?.type === 'error') error = event.error?.message ?? event.message
        },
      })

      const quota = thread ? this.takeQuota(thread) : undefined
      const extra = quota ? { quota } : {}
      if (exit.aborted) return { result: failed('stage aborted'), usage: tokens, ...extra }
      if (error || exit.code !== 0 || message === undefined) {
        return { result: failed(error ?? exit.error ?? (exit.stderr.trim() || `codex exited with code ${exit.code}`)), usage: tokens, ...extra }
      }
      return { result: parseResult(parseJson(message)), usage: tokens, ...extra }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private takeQuota(thread: string): Quota | undefined {
    const env = this.options.env ?? process.env
    const sessions = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
    const days = [new Date(), new Date(Date.now() - DAY)].map((date) =>
      join(sessions, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')),
    )
    const file = days
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith(`-${thread}.jsonl`)).map((name) => join(dir, name)))[0]
    if (!file) return undefined
    const limits = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"rate_limits"'))
      .map((line) => findLimits(parseJson(line)))
      .filter((found): found is Record<string, CodexWindow> => found !== undefined)
      .at(-1)
    rmSync(file, { force: true })
    if (!limits) return undefined
    const windows = Object.values(limits).filter((value): value is CodexWindow => typeof value === 'object' && value !== null && 'window_minutes' in value)
    const window = (minutes: number): QuotaWindow | undefined => {
      const found = windows.find((entry) => entry.window_minutes === minutes)
      if (found?.used_percent === undefined || found.resets_at === undefined) return undefined
      return { utilization: found.used_percent / 100, resetsAt: new Date(found.resets_at * 1000).toISOString() }
    }
    const fiveHour = window(FIVE_HOURS)
    const sevenDay = window(SEVEN_DAYS)
    return fiveHour || sevenDay ? { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) } : undefined
  }
}

function findLimits(value: unknown): Record<string, CodexWindow> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.rate_limits && typeof record.rate_limits === 'object') return record.rate_limits as Record<string, CodexWindow>
  for (const nested of Object.values(record)) {
    const found = findLimits(nested)
    if (found) return found
  }
  return undefined
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
