import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeHarness } from '../src/harness/claude.js'
import { CodexHarness } from '../src/harness/codex.js'
import { CommandHarness } from '../src/harness/command.js'
import { PRESETS } from '../src/harness/presets.js'
import { childEnv, parseResult, type Harness } from '../src/harness/harness.js'
import { tempDir } from './helpers.js'
import { harnessContract } from './harness-contract.js'

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname

type Stub = { command: string; argsFile: string; envFile: string }

function stub(fixture: string, options: { exitCode?: number; hang?: boolean } = {}): Stub {
  const dir = tempDir('conveyor-stub-')
  const command = join(dir, 'agent')
  const argsFile = join(dir, 'args.json')
  const envFile = join(dir, 'env.json')
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(Object.keys(process.env)))
const listed = []
const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const path = dir + '/' + entry.name; if (entry.isDirectory() || fs.statSync(path).isDirectory()) walk(path); else listed.push(path) } }
process.argv.forEach((arg, index) => { if (arg === '--add-dir' || arg === '--plugin-dir') walk(process.argv[index + 1]) })
fs.writeFileSync(${JSON.stringify(join(dir, 'skills.json'))}, JSON.stringify(listed))
process.stdout.write(fs.readFileSync(${JSON.stringify(join(FIXTURES, fixture))}, 'utf8'), () => {
  ${options.hang ? 'setInterval(() => {}, 1000)' : `process.exit(${options.exitCode ?? 0})`}
})
`,
  )
  chmodSync(command, 0o755)
  return { command, argsFile, envFile }
}

const run = (overrides: Partial<Parameters<Harness['runStage']>[0]> = {}) => ({
  prompt: 'do the stage',
  model: 'some-model',
  effort: 'high',
  cwd: tempDir('conveyor-workspace-'),
  ...overrides,
})

const harnesses = [
  { name: 'claude', fixture: 'claude-done.jsonl', make: (s: Stub, env?: NodeJS.ProcessEnv) => new ClaudeHarness({ command: s.command, env }) },
  { name: 'codex', fixture: 'codex-done.jsonl', make: (s: Stub, env?: NodeJS.ProcessEnv) => new CodexHarness({ command: s.command, env }) },
]

describe.each(harnesses)('$name harness adapter', ({ fixture, make }) => {
  it('returns the structured result and token usage', async () => {
    const output = await make(stub(fixture)).runStage(run())
    expect(output.result).toEqual({ outcome: 'done', summary: 'hello-from-file' })
    expect(output.usage.inputTokens).toBeGreaterThan(0)
    expect(output.usage.outputTokens).toBeGreaterThan(0)
  })

  it('passes model, effort, prompt, and workspace to the agent', async () => {
    const s = stub(fixture)
    const options = run()
    await make(s).runStage(options)
    const { argv, cwd } = JSON.parse(readFileSync(s.argsFile, 'utf8')) as { argv: string[]; cwd: string }
    expect(argv.join(' ')).toContain('some-model')
    expect(argv.join(' ')).toContain('high')
    expect(argv.at(-1)).toBe('do the stage')
    expect(cwd).toContain('conveyor-workspace-')
  })

  it('reports progress events', async () => {
    let events = 0
    await make(stub(fixture)).runStage(run({ onEvent: () => events++ }))
    expect(events).toBeGreaterThan(0)
  })

  it('returns failed when the agent exits with an error', async () => {
    const output = await make(stub('empty.jsonl', { exitCode: 3 })).runStage(run())
    expect(output.result.outcome).toBe('failed')
  })

  it('stops the agent on abort', async () => {
    const controller = new AbortController()
    const pending = make(stub(fixture, { hang: true })).runStage(run({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 200)
    const output = await pending
    expect(output.result).toMatchObject({ outcome: 'failed', summary: expect.stringContaining('aborted') })
  })

  it('removes board credentials from the agent environment', async () => {
    const s = stub(fixture)
    await make(s, { PATH: process.env.PATH, GH_TOKEN: 'secret', GITLAB_TOKEN: 'secret', KEEP_ME: '1' }).runStage(run())
    const keys = JSON.parse(readFileSync(s.envFile, 'utf8')) as string[]
    expect(keys).toContain('KEEP_ME')
    expect(keys).not.toContain('GH_TOKEN')
    expect(keys).not.toContain('GITLAB_TOKEN')
  })
})

describe('claude harness quota', () => {
  it('reports the subscription windows from the rate limit event', async () => {
    const output = await new ClaudeHarness({ command: stub('claude-done.jsonl').command }).runStage(run())
    expect(output.quota).toEqual({
      fiveHour: { utilization: 0.61, resetsAt: new Date(1791153000 * 1000).toISOString() },
      sevenDay: { utilization: 0.15, resetsAt: new Date(1791698400 * 1000).toISOString() },
    })
  })

  it('probes the quota with a cheap run', async () => {
    const s = stub('claude-done.jsonl')
    const quota = await new ClaudeHarness({ command: s.command }).probeQuota(tempDir())
    expect(quota?.fiveHour?.utilization).toBe(0.61)
    const { argv } = JSON.parse(readFileSync(s.argsFile, 'utf8')) as { argv: string[] }
    expect(argv.join(' ')).toContain('--model haiku')
  })
})

describe('claude harness skills', () => {
  it('attaches personal and plugin skills for the run and removes them afterwards', async () => {
    const s = stub('claude-done.jsonl')
    const skillDir = (name: string) => {
      const dir = join(tempDir(), name)
      mkdirSync(dir)
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`)
      return dir
    }
    await new ClaudeHarness({ command: s.command }).runStage(
      run({
        skills: [
          { name: 'grilling', source: 'personal', dir: skillDir('grilling') },
          { name: 'superpowers:brainstorming', source: 'plugin', plugin: 'superpowers', skill: 'brainstorming', dir: skillDir('brainstorming') },
        ],
      }),
    )
    const listed = JSON.parse(readFileSync(join(s.command, '..', 'skills.json'), 'utf8')) as string[]
    expect(listed.some((path) => path.endsWith('/personal/.claude/skills/grilling/SKILL.md'))).toBe(true)
    expect(listed.some((path) => path.endsWith('/plugins/superpowers/skills/brainstorming/SKILL.md'))).toBe(true)
    expect(listed.some((path) => path.endsWith('/plugins/superpowers/.claude-plugin/plugin.json'))).toBe(true)
    const attached = listed[0]?.split('/personal/')[0] ?? ''
    expect(existsSync(attached)).toBe(false)
  })
})

describe('claude permission mode', () => {
  const argv = async (options: Partial<Parameters<Harness['runStage']>[0]>) => {
    const s = stub('claude-done.jsonl')
    await new ClaudeHarness({ command: s.command }).runStage(run(options))
    return (JSON.parse(readFileSync(s.argsFile, 'utf8')) as { argv: string[] }).argv.join(' ')
  }

  it('bypasses permissions by default', async () => {
    expect(await argv({})).toContain('--permission-mode bypassPermissions')
  })

  it('passes the configured permission mode', async () => {
    expect(await argv({ permissionMode: 'acceptEdits' })).toContain('--permission-mode acceptEdits')
  })
})

describe('codex subscription windows', () => {
  it('reads the 5h and 7d windows from the session file and removes it', async () => {
    const home = tempDir('conveyor-codex-home-')
    const now = new Date()
    const day = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    mkdirSync(day, { recursive: true })
    const session = join(day, 'rollout-2026-10-08T10-00-00-01a10707-4d1c-75a3-b285-af43a340a572.jsonl')
    const limits = { primary: { used_percent: 18, window_minutes: 300, resets_at: 1_791_470_433 }, secondary: { used_percent: 11, window_minutes: 10_080, resets_at: 1_791_965_674 } }
    writeFileSync(session, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: limits } })}\n`)
    const s = stub('codex-done.jsonl')
    const output = await new CodexHarness({ command: s.command, env: { ...process.env, CODEX_HOME: home } }).runStage(run())
    expect(output.quota).toEqual({
      fiveHour: { utilization: 0.18, resetsAt: new Date(1_791_470_433_000).toISOString() },
      sevenDay: { utilization: 0.11, resetsAt: new Date(1_791_965_674_000).toISOString() },
    })
    expect(existsSync(session)).toBe(false)
    const { argv } = JSON.parse(readFileSync(s.argsFile, 'utf8')) as { argv: string[] }
    expect(argv).not.toContain('--ephemeral')
  })

  it('probes with the cheapest model', async () => {
    const s = stub('codex-done.jsonl')
    await new CodexHarness({ command: s.command, env: { ...process.env, CODEX_HOME: tempDir() } }).probeQuota(tempDir())
    const { argv } = JSON.parse(readFileSync(s.argsFile, 'utf8')) as { argv: string[] }
    expect(argv.join(' ')).toContain('-m gpt-6-luna')
  })
})

describe('codex sandbox options', () => {
  const argv = async (options: { sandbox?: 'workspace-write' | 'full-access'; network?: boolean }) => {
    const s = stub('codex-done.jsonl')
    await new CodexHarness({ command: s.command }).runStage(run(options))
    return (JSON.parse(readFileSync(s.argsFile, 'utf8')) as { argv: string[] }).argv.join(' ')
  }

  it('uses the workspace-write sandbox without network by default', async () => {
    expect(await argv({})).toContain('--sandbox workspace-write -c sandbox_workspace_write.network_access=false')
  })

  it('turns the network on', async () => {
    expect(await argv({ network: true })).toContain('sandbox_workspace_write.network_access=true')
  })

  it('gives full access', async () => {
    expect(await argv({ sandbox: 'full-access' })).toContain('--sandbox danger-full-access')
  })
})

describe('parseResult', () => {
  it('drops null and empty optional fields', () => {
    expect(parseResult({ outcome: 'done', summary: 's', artifact: null, questions: [], workpad: null })).toEqual({
      outcome: 'done',
      summary: 's',
    })
  })

  it('keeps artifact, questions, and workpad', () => {
    expect(
      parseResult({ outcome: 'needs_input', summary: 's', artifact: { kind: 'story', content: 'c' }, questions: ['q?'], workpad: 'w' }),
    ).toEqual({ outcome: 'needs_input', summary: 's', artifact: { kind: 'story', content: 'c' }, questions: ['q?'], workpad: 'w' })
  })

  it('turns an invalid result into failed', () => {
    expect(parseResult({ outcome: 'shipped' })).toMatchObject({ outcome: 'failed', summary: expect.stringContaining('invalid') })
  })
})

describe('childEnv', () => {
  it('removes known board credentials only', () => {
    expect(childEnv({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GL_TOKEN: 'c', GITLAB_TOKEN: 'd', HOME: '/h' })).toEqual({ HOME: '/h' })
  })
})

const real = process.env.CONVEYOR_HARNESS_REAL
if (real) {
  for (const entry of real.split(',')) {
    const [name, model = ''] = entry.split(':')
    if (name === 'claude') harnessContract('claude', () => new ClaudeHarness(), model)
    if (name === 'codex') harnessContract('codex', () => new CodexHarness(), model)
    const preset = PRESETS[name ?? '']
    if (preset) harnessContract(name ?? '', () => new CommandHarness(preset), model, { usage: false })
  }
}
