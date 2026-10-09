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

function setup(script: (board: FakeBoard) => Script, merge = 'ai') {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(join(settings, 'config.yaml'), `board: {provider: github, project: acme/app}\npickup_from: story\ntransitions: {story_to_plan: autonomous, merge: ${merge}}\nstages:\n  implement: {}\n  merge: {}\n`)
  writeFileSync(join(settings, 'local.yaml'), 'limits: {awaiting_review: 10}\n')
  mkdirSync(join(settings, 'stages'))
  const board = new FakeBoard('me')
  const harness = stageHarness(script(board))
  const workspaces = new FakeWorkspaces()
  const engine = new Engine({
    board,
    harnesses: { claude: harness },
    workspaces,
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
  return { board, harness, workspaces, cycle }
}

describe('a plan in parts', () => {
  it('merges one pull request per part in order and finishes the story after the last one', async () => {
    const { board, harness, workspaces, cycle } = setup(() => async (run) => {
      return run.stage === 'plan' ? { outcome: 'done', summary: 'planned', parts: ['Storage API', 'Settings screen'] } : { outcome: 'done', summary: `${run.stage} ok` }
    })
    await board.createTask('Store settings', 'a story', { form: 'story' })

    await cycle()
    expect(board.merges).toHaveLength(1)
    expect((await board.getTask('1'))?.state).toBe('in-progress')
    expect((await board.getTask('1'))?.closed).toBe(false)
    const first = stageRuns(harness).find((run) => run.stage === 'implement')
    expect(first?.prompt).toContain('Work only on part 1: Storage API')
    expect(workspaces.resets).toEqual(['1'])

    await cycle()
    expect(board.merges).toHaveLength(2)
    const second = stageRuns(harness).filter((run) => run.stage === 'implement')[1]
    expect(second?.prompt).toContain('Work only on part 2: Settings screen')
    expect(second?.prompt).toContain('1. Storage API (merged)')
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['plan', 'implement', 'merge', 'implement', 'merge'])
    expect(await board.getTask('1')).toMatchObject({ state: 'done' })
    expect((await board.getTask('1'))?.stage).toBeUndefined()
  })

  it('names the part in the pull request title and on the board', async () => {
    const { board, cycle } = setup(() => (run) => (run.stage === 'plan' ? { outcome: 'done', summary: 'planned', parts: ['A', 'B', 'C'] } : { outcome: 'done', summary: 'ok' }))
    await board.createTask('Big story', 'text', { form: 'story' })
    await cycle()
    expect(board.pullTitles).toEqual(['Big story (part 1/3: A)'])
    expect(board.labelsOf('1')).toContain('part::2/3')
    await cycle()
    await cycle()
    expect(board.pullTitles).toEqual(['Big story (part 1/3: A)', 'Big story (part 2/3: B)', 'Big story (part 3/3: C)'])
    expect(board.labelsOf('1').some((label) => label.startsWith('part::'))).toBe(false)
    expect((await board.getTask('1'))?.state).toBe('done')
  })

  it('waits for an approval of every part with human review', async () => {
    const { board, cycle } = setup(() => (run) => (run.stage === 'plan' ? { outcome: 'done', summary: 'planned', parts: ['A', 'B'] } : { outcome: 'done', summary: 'ok' }), 'human')
    await board.createTask('Story', 'text', { form: 'story' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('review')
    await board.addComment('1', '/approve')
    await cycle()
    expect(board.merges).toHaveLength(1)
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.pullTitles.at(-1)).toBe('Story (part 2/2: B)')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await board.addComment('1', '/approve')
    await cycle()
    expect(board.merges).toHaveLength(2)
    expect((await board.getTask('1'))?.state).toBe('done')
  })

  it('works as one pull request when the plan has no parts', async () => {
    const { board, cycle } = setup(() => () => ({ outcome: 'done', summary: 'ok' }))
    await board.createTask('Small story', 'text', { form: 'story' })
    await cycle()
    expect(board.merges).toHaveLength(1)
    expect((await board.getTask('1'))?.state).toBe('done')
    expect(board.labelsOf('1').some((label) => label.startsWith('part::'))).toBe(false)
  })
})
