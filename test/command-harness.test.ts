import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandHarness } from '../src/harness/command.js'
import { tempDir } from './helpers.js'

function agent(body: string) {
  const dir = tempDir('conveyor-agent-')
  const command = join(dir, 'agent')
  const argsFile = join(dir, 'args.json')
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }))
${body}
`,
  )
  chmodSync(command, 0o755)
  const recorded = () => JSON.parse(readFileSync(argsFile, 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string> }
  return { command, recorded }
}

const run = (overrides: Record<string, unknown> = {}) => ({
  prompt: 'do the stage',
  model: 'qwen3-coder',
  effort: 'high',
  cwd: tempDir('conveyor-workspace-'),
  ...overrides,
})

const WRITE_RESULT = `console.log('working'); fs.writeFileSync(process.env.CONVEYOR_RESULT, JSON.stringify({ outcome: 'done', summary: 'did it', artifact: null, questions: [], workpad: null }))`

describe('CommandHarness', () => {
  it('substitutes placeholders, runs in the workspace, and reads the result file', async () => {
    const { command, recorded } = agent(WRITE_RESULT)
    const harness = new CommandHarness({ command, args: ['run', '--model', '{model}', '--effort={effort}', '--dir', '{workspace}', '{prompt}'], env: {} })
    let events = 0
    const options = run({ onEvent: () => events++ })

    const output = await harness.runStage(options)

    expect(output.result).toEqual({ outcome: 'done', summary: 'did it' })
    const { argv, cwd } = recorded()
    expect(argv.slice(0, 6)).toEqual(['run', '--model', 'qwen3-coder', '--effort=high', '--dir', options.cwd])
    expect(argv.at(-1)).toContain('do the stage')
    expect(argv.at(-1)).toContain('CONVEYOR_RESULT')
    expect(cwd).toContain('conveyor-workspace-')
    expect(events).toBeGreaterThan(0)
  })

  it('passes configured environment and strips board credentials', async () => {
    const { command, recorded } = agent(WRITE_RESULT)
    await new CommandHarness({ command, args: ['{prompt}'], env: { OPENAI_BASE_URL: 'http://localhost:4000' } }, { env: { PATH: process.env.PATH, GH_TOKEN: 'secret' } }).runStage(run())
    const { env } = recorded()
    expect(env.OPENAI_BASE_URL).toBe('http://localhost:4000')
    expect(env.GH_TOKEN).toBeUndefined()
  })

  it('fills placeholders in environment values', async () => {
    const { command, recorded } = agent(WRITE_RESULT)
    const options = run()
    await new CommandHarness({ command, args: ['{prompt}'], env: { LLM_MODEL: '{model}', OPENHANDS_WORK_DIR: '{workspace}', OPENCODE_DB: '{temp}/opencode.db' } }).runStage(options)
    const { env } = recorded()
    expect(env.LLM_MODEL).toBe('qwen3-coder')
    expect(env.OPENHANDS_WORK_DIR).toBe(options.cwd)
    expect(env.OPENCODE_DB).toBe(join(dirname(env.CONVEYOR_RESULT ?? ''), 'opencode.db'))
  })

  it('fails when the agent writes no result', async () => {
    const { command } = agent(`console.error('\\x1b[91mError: \\x1b[0mmodel endpoint unreachable'); process.exit(2)`)
    const output = await new CommandHarness({ command, args: ['{prompt}'], env: {} }).runStage(run())
    expect(output.result).toMatchObject({ outcome: 'failed', summary: expect.stringContaining('Error: model endpoint unreachable') })
  })

  it('stops on abort', async () => {
    const { command } = agent(`setInterval(() => console.log('still working'), 100)`)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const output = await new CommandHarness({ command, args: ['{prompt}'], env: {} }).runStage(run({ signal: controller.signal }))
    expect(output.result).toMatchObject({ outcome: 'failed', summary: expect.stringContaining('aborted') })
  })
})
