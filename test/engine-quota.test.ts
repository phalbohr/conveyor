import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine/engine.js'
import type { Script } from '../src/harness/fake.js'
import type { Quota } from '../src/harness/harness.js'
import { UsageLedger } from '../src/usage.js'
import { FakeWorkspaces, stageHarness, stageRuns } from './fakes.js'
import { tempDir } from './helpers.js'

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()
const earlier = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function setup(options: { local: string; script?: Script; probe?: () => Promise<Quota | undefined> }) {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(join(settings, 'config.yaml'), 'board: {provider: github, project: acme/app}\nstages:\n  implement: {}\n  review: {}\n')
  writeFileSync(join(settings, 'local.yaml'), options.local)
  mkdirSync(join(settings, 'stages'))
  const board = new FakeBoard('me')
  const harness = stageHarness(options.script)
  if (options.probe) Object.assign(harness, { probeQuota: options.probe })
  const engine = new Engine({
    board,
    harnesses: { claude: harness },
    workspaces: new FakeWorkspaces(),
    settingsDir: settings,
    repo: tempDir(),
    home: tempDir(),
    usage: new UsageLedger(),
    loadConfig: () => loadConfig(settings),
  })
  const cycle = async () => {
    await engine.tick()
    await engine.idle()
  }
  const runs = () => stageRuns(harness).map((run) => `${run.taskId}:${run.stage}`)
  return { board, harness, engine, cycle, runs }
}

const withQuota = (quota: Quota): Script => (run) =>
  run.stage === 'implement' ? { result: { outcome: 'done', summary: 'ok' }, usage: { inputTokens: 1, outputTokens: 1 }, quota } : { outcome: 'done', summary: 'ok' }

describe('Engine subscription reserve', () => {
  it('stops before the next stage when the five-hour reserve is reached', async () => {
    const { board, cycle, runs } = setup({
      local: 'limits: {subscription: {five_hour_reserve: 10}}\n',
      script: withQuota({ fiveHour: { utilization: 0.92, resetsAt: later(30) } }),
    })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement'])
    expect((await board.getTask('1'))?.state).toBe('in-progress')

    await board.createTask('Second', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement'])
  })

  it('uses a separate reserve for the seven-day window', async () => {
    const { board, cycle, runs } = setup({
      local: 'limits: {subscription: {five_hour_reserve: 10, seven_day_reserve: 20}}\n',
      script: withQuota({ fiveHour: { utilization: 0.5, resetsAt: later(30) }, sevenDay: { utilization: 0.85, resetsAt: later(3000) } }),
    })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement'])
  })

  it('keeps working below the reserve and after the window resets', async () => {
    const { board, cycle, runs } = setup({
      local: 'limits: {subscription: {five_hour_reserve: 10, seven_day_reserve: 15}}\n',
      script: withQuota({ fiveHour: { utilization: 0.95, resetsAt: earlier(1) }, sevenDay: { utilization: 0.8, resetsAt: later(3000) } }),
    })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:review', '1:merge'])
  })

  it('ignores the quota when no reserve is configured', async () => {
    const { board, cycle, runs } = setup({ local: 'limits: {}\n', script: withQuota({ fiveHour: { utilization: 0.99, resetsAt: later(30) } }) })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:review', '1:merge'])
  })

  it('probes the quota before claiming when probing is enabled', async () => {
    let probes = 0
    const { board, cycle, runs } = setup({
      local: 'limits: {subscription: {five_hour_reserve: 10, probe: true}}\n',
      probe: async () => {
        probes++
        return { fiveHour: { utilization: 0.95, resetsAt: later(30) } }
      },
    })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    expect(probes).toBe(1)
    expect(runs()).toEqual([])
  })
})
