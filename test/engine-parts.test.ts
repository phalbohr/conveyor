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

function setup(script: (board: FakeBoard) => Script, merge = 'ai', extra = '', stages = '  implement: {}\n  merge: {}') {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(join(settings, 'config.yaml'), `board: {provider: github, project: acme/app}\npickup_from: story\ntransitions: {story_to_plan: autonomous, merge: ${merge}}\nstages:\n${stages}\n${extra}`)
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
    expect(board.pullBodies[0]).toMatch(/^Part of #1, part 1 of 3: A\./)
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

  it('collects all parts in one draft pull request with parts: together and asks for review after the last part', async () => {
    const { board, harness, workspaces, cycle } = setup(
      () => (run) => (run.stage === 'plan' ? { outcome: 'done', summary: 'planned', parts: ['A', 'B', 'C'] } : { outcome: 'done', summary: `${run.stage} ok` }),
      'human',
      'parts: together\n',
    )
    await board.createTask('Big story', 'text', { form: 'story' })

    await cycle()
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['plan', 'implement'])
    expect(board.pullTitles).toEqual(['Big story'])
    expect(await board.pullRequest('1')).toMatchObject({ state: 'open', draft: true })
    expect(board.pullBodies[0]).toContain('- [x] 1. A\n- [ ] 2. B\n- [ ] 3. C')
    expect(board.labelsOf('1')).toContain('part::2/3')
    expect((await board.getTask('1'))?.state).toBe('in-progress')
    expect((await board.listComments('1')).some((comment) => comment.body.includes('Draft pull request for all parts of this task'))).toBe(true)

    await cycle()
    expect(board.pullTitles).toHaveLength(1)
    expect(board.labelsOf('1')).toContain('part::3/3')

    await cycle()
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['plan', 'implement', 'implement', 'implement', 'merge'])
    expect(stageRuns(harness).filter((run) => run.stage === 'implement')[2]?.prompt).toContain('Work only on part 3: C')
    expect(stageRuns(harness).filter((run) => run.stage === 'implement')[2]?.prompt).toContain('1. A (done)\n2. B (done)\n3. C (this part)')
    expect(stageRuns(harness).filter((run) => run.stage === 'implement')[2]?.prompt).toContain('The earlier parts are done in the task branch')
    expect(board.readied).toEqual([{ id: '1', title: 'Big story', body: expect.stringContaining('- [x] 3. C') }])
    expect((await board.pullRequest('1'))?.draft).toBeUndefined()
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.merges).toEqual([])
    expect(workspaces.resets).toEqual([])

    await board.addComment('1', '/approve')
    await cycle()
    expect(board.merges).toHaveLength(1)
    expect((await board.getTask('1'))?.state).toBe('done')
  })

  it('runs the review stage once, on the last part, over all parts with parts: together', async () => {
    const { board, harness, cycle } = setup(
      () => (run) => (run.stage === 'plan' ? { outcome: 'done', summary: 'planned', parts: ['A', 'B'] } : { outcome: 'done', summary: 'ok' }),
      'human',
      'parts: together\n',
      '  implement: {}\n  review: {}\n  merge: {}',
    )
    await board.createTask('Story', 'text', { form: 'story' })
    await cycle()
    await cycle()
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['plan', 'implement', 'implement', 'review', 'merge'])
    expect(stageRuns(harness).find((run) => run.stage === 'review')?.prompt).toContain('review all parts together')
  })

  it('starts again from the first part on /rework with parts: together', async () => {
    const { board, harness, cycle } = setup(
      () => (run) => (run.stage === 'plan' ? { outcome: 'done', summary: 'planned', parts: ['A', 'B'] } : { outcome: 'done', summary: 'ok' }),
      'human',
      'parts: together\n',
    )
    await board.createTask('Story', 'text', { form: 'story' })
    await cycle()
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('review')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await board.addComment('1', '/rework')
    await cycle()
    const implement = stageRuns(harness).filter((run) => run.stage === 'implement')
    expect(implement.at(-1)?.prompt).toContain('Work only on part 1: A')
    expect(board.labelsOf('1')).toContain('part::2/2')
    expect(board.pullTitles).toEqual(['Story', 'Story'])
    expect(await board.pullRequest('1')).toMatchObject({ state: 'open', draft: true })
  })

  it('retries only the draft pull request after it failed to open with parts: together', async () => {
    const { board, harness, cycle } = setup(
      () => (run) => (run.stage === 'plan' ? { outcome: 'done', summary: 'planned', parts: ['A', 'B'] } : { outcome: 'done', summary: 'ok' }),
      'human',
      'parts: together\n',
    )
    const open = board.openPullRequest.bind(board)
    board.openPullRequest = async () => {
      throw new Error('source_branch does not exist')
    }
    await board.createTask('Story', 'text', { form: 'story' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    board.openPullRequest = open
    await new Promise((resolve) => setTimeout(resolve, 5))
    await board.addComment('1', 'fixed, retry')
    await cycle()
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['plan', 'implement'])
    expect(board.pullTitles).toEqual(['Story'])
    expect(board.labelsOf('1')).toContain('part::2/2')
    await cycle()
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['plan', 'implement', 'implement', 'merge'])
    expect((await board.getTask('1'))?.state).toBe('review')
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

describe('pull request references', () => {
  it('never lets a pull request close the issue; the conveyor closes it when the task is done', async () => {
    const { board, cycle } = setup(() => (run) => (run.stage === 'plan' ? { outcome: 'done', summary: 'planned', parts: ['A', 'B'] } : { outcome: 'done', summary: 'ok' }), 'ai', 'close_on_done: true\n')
    await board.createTask('Big story', 'text', { form: 'story' })
    await cycle()
    await cycle()
    expect(board.pullBodies.map((body) => body.split('.')[0])).toEqual(['Part of #1, part 1 of 2: A', 'Part of #1, part 2 of 2: B'])
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: true })
  })
})
