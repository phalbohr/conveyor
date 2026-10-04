import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedSkill } from '../skills.js'
import { NO_USAGE, RESULT_SCHEMA, childEnv, failed, parseResult, type Harness, type HarnessOptions, type Quota, type StageOutput, type StageRun } from './harness.js'
import { spawnLines } from './process.js'

type RateLimitEvent = {
  type: 'rate_limit_event'
  rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> }
}

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
    const attached = attachSkills(run.skills ?? [])
    try {
      return await this.execute(run, attached.args)
    } finally {
      attached.cleanup()
    }
  }

  async probeQuota(cwd: string): Promise<Quota | undefined> {
    const output = await this.execute({ prompt: 'Reply with the word ok.', model: 'haiku', effort: 'low', cwd }, [])
    return output.quota
  }

  private async execute(run: StageRun, skillArgs: string[]): Promise<StageOutput> {
    let last: ResultEvent | undefined
    let quota: Quota | undefined
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
      ...skillArgs,
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
        if (event?.type === 'rate_limit_event') quota = toQuota(event as RateLimitEvent) ?? quota
      },
    })

    const extra = quota ? { quota } : {}
    if (exit.aborted) return { result: failed('stage aborted'), usage: usage(last), ...extra }
    if (!last || last.is_error || exit.code !== 0) {
      return { result: failed(last?.result ?? exit.error ?? (exit.stderr.trim() || `claude exited with code ${exit.code}`)), usage: usage(last), ...extra }
    }
    return { result: parseResult(last.structured_output), usage: usage(last), ...extra }
  }
}

function attachSkills(skills: ResolvedSkill[]): { args: string[]; cleanup: () => void } {
  if (skills.length === 0) return { args: [], cleanup: () => undefined }
  const root = mkdtempSync(join(tmpdir(), 'conveyor-skills-'))
  const args: string[] = []
  const link = (target: string, path: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    symlinkSync(target, path)
  }

  const personal = skills.filter((skill) => skill.source === 'personal')
  if (personal.length > 0) {
    for (const skill of personal) link(skill.dir, join(root, 'personal', '.claude', 'skills', skill.name))
    args.push('--add-dir', join(root, 'personal'))
  }

  const plugins = new Map<string, Extract<ResolvedSkill, { source: 'plugin' }>[]>()
  for (const skill of skills) if (skill.source === 'plugin') plugins.set(skill.plugin, [...(plugins.get(skill.plugin) ?? []), skill])
  for (const [plugin, pluginSkills] of plugins) {
    const dir = join(root, 'plugins', plugin)
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: plugin, version: '0.0.0', description: 'conveyor stage skills' }))
    for (const skill of pluginSkills) link(skill.dir, join(dir, 'skills', skill.skill))
    args.push('--plugin-dir', dir)
  }
  return { args, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function toQuota(event: RateLimitEvent): Quota | undefined {
  const windows = event.rate_limit_info?.unifiedWindows
  if (!windows) return undefined
  const window = (name: string) => {
    const value = windows[name]
    if (value?.utilization === undefined || value.resetsAt === undefined) return undefined
    return { utilization: value.utilization, resetsAt: new Date(value.resetsAt * 1000).toISOString() }
  }
  const fiveHour = window('five_hour')
  const sevenDay = window('seven_day')
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
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
