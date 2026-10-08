import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine/engine.js'
import { UsageLedger } from '../src/usage.js'
import { renderWorkpad, type WorkpadState } from '../src/engine/workpad.js'
import type { Script } from '../src/harness/fake.js'
import type { StageResult } from '../src/harness/harness.js'
import { FakeWorkspaces, stageHarness, stageRuns } from './fakes.js'
import { tempDir } from './helpers.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const done: StageResult = { outcome: 'done', summary: 'ok' }
const never = () => new Promise<StageResult>(() => undefined)

function setup(options: { config?: string; script?: Script } = {}) {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(
    join(settings, 'config.yaml'),
    `board: {provider: github, project: acme/app}\nstages:\n  implement: {}\n  review: {}\n${options.config ?? ''}`,
  )
  mkdirSync(join(settings, 'stages'))
  const repo = tempDir('conveyor-repo-')
  const usage = new UsageLedger()
  const board = new FakeBoard('me')
  const harness = stageHarness(options.script)
  const workspaces = new FakeWorkspaces()
  const engine = new Engine({
    board,
    harnesses: { claude: harness },
    workspaces,
    settingsDir: settings,
    repo,
    usage,
    home: tempDir(),
    loadConfig: () => loadConfig(settings),
  })
  const cycle = async () => {
    await engine.tick()
    await engine.idle()
  }
  const runs = () => stageRuns(harness).map((run) => `${run.taskId}:${run.stage}`)
  const workpad = async (id = '1') => (await board.listComments(id)).find((c) => c.body.includes('conveyor:workpad'))?.body ?? ''
  const started = (expected: string[]) => vi.waitFor(() => expect(runs()).toEqual(expected))
  return { settings, board, harness, workspaces, engine, cycle, runs, workpad, started }
}

async function foreignTask(board: FakeBoard, state: WorkpadState, label: 'in-progress' | 'needs-input' | 'review' = 'in-progress') {
  const task = await board.createTask('Foreign', 'plan', { form: 'plan' })
  await board.claim(task.id)
  await board.setOwner(task.id, 'alice')
  await board.setState(task.id, label)
  await board.addComment(task.id, renderWorkpad(state, 'previous work'))
  return task
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Engine retries', () => {
  it('retries a failed stage after the backoff', async () => {
    const { board, cycle, runs, workpad } = setup({
      script: (run, index) => (run.stage === 'implement' && index === 0 ? { outcome: 'failed', summary: 'tests are red' } : done),
    })
    await board.createTask('Login', 'p', { form: 'plan' })

    await cycle()
    expect(await workpad()).toContain('tests are red')
    await cycle()
    expect(runs()).toEqual(['1:implement'])

    await vi.advanceTimersByTimeAsync(10_000)
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:implement', '1:review', '1:merge'])
  })

  it('asks a human after the maximum number of attempts and resumes on reply', async () => {
    let failures = 2
    const { board, cycle, runs } = setup({
      config: 'retry: {max_attempts: 2}\n',
      script: (run) => (run.stage === 'implement' && failures-- > 0 ? { outcome: 'failed', summary: 'broken build' } : done),
    })
    await board.createTask('Login', 'p', { form: 'plan' })

    await cycle()
    await vi.advanceTimersByTimeAsync(10_000)
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    expect((await board.listComments('1')).at(-1)?.body).toContain('broken build')

    await board.addComment('1', 'Fixed the CI secret, try again.')
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:implement', '1:implement', '1:review', '1:merge'])
  })
})

describe('Engine timeouts', () => {
  it('stops a stage after the stage timeout and schedules a retry', async () => {
    const { board, engine, workpad, started } = setup({
      config: 'timeouts: {stage: 2m, stall: 0}\n',
      script: (run, index) => (index === 0 ? never() : done),
    })
    await board.createTask('Login', 'p', { form: 'plan' })

    await engine.tick()
    await started(['1:implement'])
    await vi.advanceTimersByTimeAsync(2 * MINUTE + 1)
    await engine.idle()

    expect(await workpad()).toContain('timed out')
    expect(await workpad()).toContain('"attempt":1')
  })

  it('stops a stage without events after the stall timeout', async () => {
    const { board, engine, workpad, started } = setup({ config: 'timeouts: {stage: 60m, stall: 1m}\n', script: never })
    await board.createTask('Login', 'p', { form: 'plan' })

    await engine.tick()
    await started(['1:implement'])
    await vi.advanceTimersByTimeAsync(MINUTE + 1)
    await engine.idle()

    expect(await workpad()).toContain('stalled')
  })

  it('keeps a stage with events alive', async () => {
    const { board, engine, runs } = setup({
      config: 'timeouts: {stage: 60m, stall: 1m}\n',
      script: (run) =>
        run.stage === 'implement'
          ? new Promise<StageResult>((resolve) => {
              const beat = setInterval(() => run.onEvent?.(), 30_000)
              setTimeout(() => {
                clearInterval(beat)
                resolve(done)
              }, 5 * MINUTE)
            })
          : done,
    })
    await board.createTask('Login', 'p', { form: 'plan' })

    await engine.tick()
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 1)
    await engine.idle()

    expect(runs()).toEqual(['1:implement', '1:review', '1:merge'])
  })

  it('refreshes the heartbeat during a long stage', async () => {
    const { board, engine, workpad, started } = setup({ config: 'timeouts: {stall: 0, heartbeat: 30m}\n', script: never })
    await board.createTask('Login', 'p', { form: 'plan' })
    await engine.tick()
    await started(['1:implement'])
    const before = await workpad()

    await vi.advanceTimersByTimeAsync(11 * MINUTE)

    expect(await workpad()).not.toBe(before)
    expect(await workpad()).toContain('2026-10-05T10:1')
  })
})

describe('Engine reconciliation', () => {
  it('stops the stage and removes the workspace when the task is closed', async () => {
    const { board, engine, workspaces, started } = setup({ script: never })
    await board.createTask('Login', 'p', { form: 'plan' })
    await engine.tick()
    await started(['1:implement'])

    await board.closeTask('1')
    await engine.tick()
    await engine.idle()

    expect(workspaces.removed).toEqual(['1'])
    expect((await board.getTask('1'))?.state).toBe('in-progress')
  })

  it('stops the stage and keeps the workspace when the task is taken back', async () => {
    const { board, engine, workspaces, workpad, started } = setup({ script: never })
    await board.createTask('Login', 'p', { form: 'plan' })
    await engine.tick()
    await started(['1:implement'])
    const before = await workpad()

    await board.setOwner('1', 'alice')
    await engine.tick()
    await engine.idle()

    expect(workspaces.removed).toEqual([])
    expect(await workpad()).toBe(before)
  })

  it('reconciles even with an invalid configuration', async () => {
    const { board, engine, settings, workspaces, started } = setup({ script: never })
    await board.createTask('Login', 'p', { form: 'plan' })
    await engine.tick()
    await started(['1:implement'])

    writeFileSync(join(settings, 'config.yaml'), 'board: {provider: jira, project: x}\n')
    await board.closeTask('1')
    await engine.tick()
    await engine.idle()

    expect(workspaces.removed).toEqual(['1'])
  })
})

describe('Engine releases', () => {
  it('releases a stale task of another workstation and continues it', async () => {
    const { board, cycle, runs } = setup()
    await foreignTask(board, { stage: 'review', attempt: 0, heartbeat: new Date(Date.now() - 31 * MINUTE).toISOString() })

    await cycle()

    const comments = await board.listComments('1')
    expect(comments.some((c) => c.body.includes('conveyor:release') && c.body.includes('alice'))).toBe(true)
    expect(runs()).toEqual(['1:review', '1:merge'])
    expect((await board.getTask('1'))?.owner).toBe('me')
  })

  it('keeps a task with a fresh heartbeat', async () => {
    const { board, cycle, runs } = setup()
    await foreignTask(board, { stage: 'review', attempt: 0, heartbeat: new Date(Date.now() - 29 * MINUTE).toISOString() })
    await cycle()
    expect(runs()).toEqual([])
    expect((await board.getTask('1'))?.owner).toBe('alice')
  })

  it('never releases a task with private artifacts automatically', async () => {
    const { board, cycle } = setup()
    await foreignTask(board, { stage: 'review', attempt: 0, private: true, heartbeat: new Date(Date.now() - DAY).toISOString() })
    await cycle()
    expect((await board.getTask('1'))?.owner).toBe('alice')
  })

  it('releases a waiting task after the waiting timeout in calendar days', async () => {
    const { board, cycle } = setup()
    await foreignTask(board, { attempt: 0, waiting: { kind: 'review', since: new Date(Date.now() - 4 * DAY - MINUTE).toISOString() } }, 'review')
    await foreignTask(board, { attempt: 0, waiting: { kind: 'review', since: new Date(Date.now() - 3 * DAY).toISOString() } }, 'review')

    await cycle()

    expect((await board.getTask('1'))?.owner).toBeUndefined()
    expect((await board.getTask('2'))?.owner).toBe('alice')
    expect(await board.claim('1')).toBe(true)
  })

  it('counts the waiting timeout in working days', async () => {
    vi.setSystemTime(new Date('2026-10-12T11:00:00'))
    const { board, cycle } = setup({ config: 'timeouts: {waiting: 2wd}\n' })
    await foreignTask(board, { attempt: 0, waiting: { kind: 'review', since: new Date('2026-10-09T10:00:00').toISOString() } }, 'review')

    await cycle()
    expect((await board.getTask('1'))?.owner).toBe('alice')

    vi.setSystemTime(new Date('2026-10-13T10:01:00'))
    await cycle()
    expect((await board.getTask('1'))?.owner).toBeUndefined()
  })
})
