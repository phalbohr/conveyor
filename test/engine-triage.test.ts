import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine/engine.js'
import { FakeHarness, type Script } from '../src/harness/fake.js'
import type { StageResult } from '../src/harness/harness.js'
import { UsageLedger } from '../src/usage.js'
import { FakeWorkspaces } from './fakes.js'
import { tempDir } from './helpers.js'

const triage = (tasks: unknown): StageResult => ({
  outcome: 'done',
  summary: 'triaged',
  artifact: { kind: 'triage', content: JSON.stringify({ tasks }) },
})

function setup(script: Script) {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(
    join(settings, 'config.yaml'),
    'board: {provider: github, project: acme/app}\ntriage: {model: opus, effort: high}\nstages:\n  implement: {}\n  merge: {}\n',
  )
  writeFileSync(join(settings, 'local.yaml'), 'limits: {running: 1, awaiting_review: 10}\n')
  mkdirSync(join(settings, 'stages'))
  writeFileSync(join(settings, 'triage.md'), 'Order the tasks by value.')
  const board = new FakeBoard('me')
  const harness = new FakeHarness(script)
  const repo = tempDir('conveyor-repo-')
  const engine = new Engine({
    board,
    harnesses: { claude: harness },
    workspaces: new FakeWorkspaces(),
    settingsDir: settings,
    repo,
    home: tempDir(),
    usage: new UsageLedger(),
    loadConfig: () => loadConfig(settings),
  })
  const cycle = async () => {
    await engine.tick()
    await engine.idle()
  }
  const runs = () => harness.runs.map((run) => `${run.taskId ?? '-'}:${run.stage}`)
  return { board, harness, engine, cycle, runs, repo }
}

const stageDone: StageResult = { outcome: 'done', summary: 'ok' }

describe('Engine triage', () => {
  it('sets priorities and blockers for new tasks before claiming', async () => {
    const { board, cycle, runs, harness, repo } = setup((run) =>
      run.stage === 'triage'
        ? triage([
            { id: '1', priority: 3, blocked_by: [] },
            { id: '2', priority: 1, blocked_by: [] },
            { id: '3', priority: 2, blocked_by: ['2'] },
          ])
        : stageDone,
    )
    await board.createTask('Nice to have', 'p', 'plan')
    await board.createTask('Foundation', 'p', 'plan')
    await board.createTask('Feature on top', 'p', 'plan')

    await cycle()

    expect(await board.getTask('1')).toMatchObject({ priority: 3 })
    expect(await board.getTask('3')).toMatchObject({ priority: 2, openBlockers: 1 })
    expect(runs()).toEqual(['-:triage', '2:implement', '2:merge'])
    expect(harness.runs[0]).toMatchObject({ model: 'opus', effort: 'high' })
    expect(harness.runs[0]?.cwd).not.toBe(repo)
    expect(harness.runs[0]?.cwd).toContain('conveyor-triage-')
    expect(existsSync(harness.runs[0]?.cwd ?? '')).toBe(false)
    expect(harness.runs[0]?.prompt).toContain('Order the tasks by value.')
    expect(harness.runs[0]?.prompt).toContain('Feature on top')
  })

  it('does not run when every new task has a priority', async () => {
    const { board, cycle, runs } = setup(() => stageDone)
    await board.createTask('Ready', 'p', 'plan')
    await board.setPriority('1', 2)
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge'])
  })

  it('gives the default priority to tasks the triage left out and ignores invalid entries', async () => {
    const { board, cycle } = setup((run) =>
      run.stage === 'triage' ? triage([{ id: '1', priority: 1, blocked_by: ['1', '99'] }, { id: '42', priority: 2 }]) : stageDone,
    )
    await board.createTask('First', 'p', 'plan')
    await board.createTask('Second', 'p', 'story')
    await cycle()
    expect(await board.getTask('1')).toMatchObject({ priority: 1, openBlockers: 0 })
    expect((await board.getTask('2'))?.priority).toBe(3)
  })

  it('waits while another workstation runs the triage', async () => {
    const { board, cycle, runs } = setup((run) => (run.stage === 'triage' ? triage([]) : stageDone))
    await board.claim('triage')
    await board.createTask('New', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect((await board.getTask('1'))?.priority).toBeUndefined()
  })

  it('does not retry a failed triage before the backoff', async () => {
    const { board, cycle, runs } = setup((run) => (run.stage === 'triage' ? { outcome: 'failed', summary: 'no idea' } : stageDone))
    await board.createTask('New', 'p', 'story')
    await cycle()
    await cycle()
    expect(runs()).toEqual(['-:triage'])
    expect(await board.claim('triage')).toBe(true)
  })
})
