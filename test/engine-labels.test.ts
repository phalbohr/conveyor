import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine/engine.js'
import type { Script } from '../src/harness/fake.js'
import { UsageLedger } from '../src/usage.js'
import { FakeWorkspaces, stageHarness, stageRuns } from './fakes.js'
import { tempDir } from './helpers.js'

function setup(options: { config?: string; script?: (board: FakeBoard) => Script } = {}) {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(
    join(settings, 'config.yaml'),
    ['board: {provider: github, project: acme/app}', 'transitions: {idea_to_story: autonomous, story_to_plan: autonomous}', 'stages:', '  implement: {}', '  polish: {}', '  merge: {}', options.config ?? ''].join('\n'),
  )
  writeFileSync(join(settings, 'local.yaml'), 'limits: {awaiting_review: 10}\n')
  mkdirSync(join(settings, 'stages'))
  const board = new FakeBoard('me')
  const harness = stageHarness(options.script?.(board))
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
  return { board, cycle, runs }
}

describe('board labels', () => {
  it('takes a backlog task with a form, removes the form, and shows the running stage', async () => {
    const seen: string[] = []
    const { board, cycle, runs } = setup({
      config: 'pickup_from: idea',
      script: (fake) => async (run) => {
        const task = await fake.getTask(run.taskId ?? '')
        seen.push(`${task?.state}:${task?.stage}:${task?.form ?? '-'}`)
        return { outcome: 'done', summary: 'ok' }
      },
    })
    await board.createTask('Search', 'an idea', { state: 'backlog', form: 'idea' })

    await cycle()

    expect(runs()).toEqual(['1:story', '1:plan', '1:implement', '1:polish', '1:merge'])
    expect(seen).toEqual(['in-progress:story:-', 'in-progress:plan:-', 'in-progress:implement:-', 'in-progress:polish:-', 'in-progress:merge:-'])
    const task = await board.getTask('1')
    expect(task).toMatchObject({ state: 'review' })
    expect(task?.stage).toBeUndefined()
    expect(task?.form).toBeUndefined()
  })

  it('leaves backlog drafts without a form alone', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Draft', 'notes', { state: 'backlog' })
    await board.createTask('Unlabeled', 'notes')
    await cycle()
    expect(runs()).toEqual([])
    expect((await board.getTask('1'))?.state).toBe('backlog')
  })

  it('takes only the forms that pickup_from allows', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Idea', 'i', { form: 'idea' })
    await board.createTask('Story', 's', { form: 'story' })
    await board.createTask('Plan', 'p', { form: 'plan' })
    await cycle()
    expect(runs()).toEqual(['3:implement', '3:polish', '3:merge'])
    expect((await board.getTask('1'))?.form).toBe('idea')
  })

  it('starts a story with the plan stage', async () => {
    const { board, cycle, runs } = setup({ config: 'pickup_from: story' })
    await board.createTask('Story', 's', { form: 'story' })
    await cycle()
    expect(runs()).toEqual(['1:plan', '1:implement', '1:polish', '1:merge'])
  })

  it('keeps the stage label while the stage waits for input', async () => {
    const { board, cycle } = setup({ script: () => (run) => (run.stage === 'polish' ? { outcome: 'needs_input', summary: 'q', questions: ['Which style?'] } : { outcome: 'done', summary: 'ok' }) })
    await board.createTask('Plan', 'p', { form: 'plan' })
    await cycle()
    expect(await board.getTask('1')).toMatchObject({ state: 'needs-input', stage: 'polish' })
  })

  it('syncs the project columns with the labels on every cycle', async () => {
    const { board, cycle } = setup()
    let synced: string[] = []
    board.syncMirror = async (tasks) => {
      synced = tasks.map((task) => `${task.id}:${task.state}`)
      return tasks.length
    }
    await board.createTask('Draft', 'notes', { state: 'backlog' })
    await cycle()
    expect(synced).toEqual(['1:backlog'])
  })

  it('prepares labels for every configured stage', async () => {
    const board = new FakeBoard('me')
    await board.prepare(['story', 'plan', 'implement', 'polish', 'merge'])
    expect([...board.labels]).toEqual(expect.arrayContaining(['conveyor::backlog', 'form::idea', 'stage::polish']))
    expect([...board.labels]).not.toContain('conveyor::ready')
  })
})
