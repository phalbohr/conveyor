import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine/engine.js'
import type { Script } from '../src/harness/fake.js'
import type { StageResult } from '../src/harness/harness.js'
import { UsageLedger } from '../src/usage.js'
import { FakeWorkspaces, stageHarness, stageRuns } from './fakes.js'
import { tempDir } from './helpers.js'

const done: StageResult = { outcome: 'done', summary: 'ok' }

function setup(options: { mode?: 'human' | 'ai' | 'smart'; stages?: string; config?: string; script?: Script } = {}) {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(
    join(settings, 'config.yaml'),
    [
      'board: {provider: github, project: acme/app}',
      `transitions: {merge: ${options.mode ?? 'human'}}`,
      'stages:',
      options.stages ?? '  implement: {}\n  merge: {}',
      options.config ?? '',
    ].join('\n'),
  )
  writeFileSync(join(settings, 'local.yaml'), 'limits: {awaiting_review: 10}\n')
  mkdirSync(join(settings, 'stages'))
  const board = new FakeBoard('me')
  const harness = stageHarness(options.script)
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
  const runs = () => stageRuns(harness).map((run) => `${run.taskId}:${run.stage}`)
  const expireRetry = async (id = '1') => {
    const comments = await board.listComments(id)
    const pad = comments.find((c) => c.body.includes('conveyor:workpad'))
    if (pad) await board.updateComment(pad.id, pad.body.replace(/"retryAt":"[^"]+"/, '"retryAt":"2000-01-01T00:00:00.000Z"'))
  }
  return { board, harness, workspaces, engine, cycle, runs, expireRetry }
}

describe('merge mode human', () => {
  it('opens a pull request after the merge stage and waits for review', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Add login', 'p', 'plan')

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect(await board.pullRequest('1')).toMatchObject({ state: 'open' })
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.merges).toEqual([])
  })

  it('finishes the task after a human merges the pull request', async () => {
    const { board, cycle, runs, workspaces } = setup({
      stages: '  implement: {}\n  merge: {}\n  verify: {when: success}\n  fix-ci: {when: failure}',
    })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    board.updatePullRequest('1', { state: 'merged' })

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge', '1:verify'])
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: true })
    expect(await board.claim('1')).toBe(true)
    expect(workspaces.removed).toEqual(['1'])
    expect(workspaces.deletedBranches).toEqual(['1'])
  })

  it('keeps waiting for a plain comment', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    await board.addComment('1', 'Looks good so far, I will check it tomorrow.')
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.merges).toEqual([])
  })

  it('merges after a /merge comment on the issue', async () => {
    const { board, cycle } = setup({ stages: '  implement: {}\n  merge: {}\n  verify: {when: success}' })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    await board.addComment('1', '/merge')
    await cycle()
    expect(board.merges).toHaveLength(1)
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: true })
  })

  it('merges after a /merge comment on the pull request', async () => {
    const { board, cycle } = setup()
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    board.updatePullRequest('1', { comments: [{ author: 'alice', body: '/merge looks right', createdAt: new Date().toISOString() }] })
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('waits for the configured number of distinct approvals', async () => {
    const { board, cycle } = setup({ config: 'review: {approvals: 2}' })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    await board.addComment('1', '/merge')
    await board.addComment('1', '/merge again')
    await cycle()
    expect(board.merges).toEqual([])

    board.updatePullRequest('1', { approvedBy: ['alice'] })
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('restarts after a /rework comment with its text as feedback', async () => {
    const { board, cycle, harness } = setup()
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    await board.addComment('1', '/merge')
    board.updatePullRequest('1', { comments: [{ author: 'alice', body: '/rework Validate the email format.', createdAt: new Date().toISOString() }] })
    await cycle()
    expect(board.merges).toEqual([])
    expect(stageRuns(harness)[2]?.stage).toBe('implement')
    expect(stageRuns(harness)[2]?.prompt).toContain('Validate the email format.')
  })
})

describe('merge mode ai', () => {
  it('merges the pull request with the configured method and finishes the task', async () => {
    const { board, cycle, runs } = setup({ mode: 'ai', config: 'merge_method: squash' })
    await board.createTask('Add login', 'p', 'plan')

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect(board.merges).toEqual([{ id: '1', method: 'squash' }])
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: true })
  })

  it('waits for open blockers before merging', async () => {
    const { board, cycle, expireRetry } = setup({
      mode: 'ai',
      script: async (run) => {
        if (run.stage === 'implement') await board.addBlocker('1', '2')
        return done
      },
    })
    await board.createTask('Feature', 'p', 'plan')
    await board.createTask('Foundation', 'p', 'story')
    await cycle()
    expect(board.merges).toEqual([])
    expect((await board.getTask('1'))?.state).toBe('in-progress')

    await board.closeTask('2')
    await expireRetry()
    await cycle()
    expect(board.merges).toEqual([{ id: '1', method: 'merge' }])
  })

  it('waits for pending checks', async () => {
    const { board, cycle, harness, expireRetry } = setup({
      mode: 'ai',
      script: (run) => {
        if (run.stage === 'merge') board.updatePullRequest('1', { checks: 'pending' })
        return done
      },
    })
    await board.createTask('Add login', 'p', 'plan')
    await board.openPullRequest('1')
    await cycle()
    expect(board.merges).toEqual([])
    expect((await board.getTask('1'))?.state).toBe('in-progress')

    board.updatePullRequest('1', { checks: 'success' })
    await expireRetry()
    await cycle()
    expect(board.merges).toHaveLength(1)
    expect(stageRuns(harness)).toHaveLength(2)
  })

  it('runs failure stages when checks fail and merges after the fix', async () => {
    const { board, cycle, runs, harness, expireRetry } = setup({
      mode: 'ai',
      stages: '  implement: {}\n  merge: {}\n  fix-ci: {when: failure}',
      script: (run) => {
        if (run.stage === 'merge') board.updatePullRequest('1', { checks: 'failure' })
        if (run.stage === 'fix-ci') board.updatePullRequest('1', { checks: 'success' })
        return done
      },
    })
    await board.createTask('Add login', 'p', 'plan')
    await board.openPullRequest('1')

    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge', '1:fix-ci'])
    expect(stageRuns(harness)[2]?.prompt).toContain('checks failed')

    await expireRetry()
    await cycle()
    expect(board.merges).toHaveLength(1)
    expect((await board.getTask('1'))?.state).toBe('done')
  })

  it('asks a human when the merge fails and no failure stage exists', async () => {
    const { board, cycle } = setup({ mode: 'ai' })
    board.mergeError = 'merge conflict'
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    expect((await board.listComments('1')).at(-1)?.body).toContain('merge conflict')
  })

  it('waits while another workstation merges', async () => {
    const { board, cycle, expireRetry } = setup({ mode: 'ai' })
    await board.claim('merge')
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect(board.merges).toEqual([])

    await board.release('merge')
    await expireRetry()
    await cycle()
    expect(board.merges).toHaveLength(1)
  })
})

describe('merge mode smart', () => {
  it('sends the change to review when the merge stage asks for approval', async () => {
    const { board, cycle, harness } = setup({
      mode: 'smart',
      script: (run) => (run.stage === 'merge' ? { outcome: 'approval', summary: 'touches the schema' } : done),
    })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.merges).toEqual([])
    expect(stageRuns(harness)[1]?.prompt).toContain('human review')
  })

  it('merges when the merge stage returns done', async () => {
    const { board, cycle } = setup({ mode: 'smart' })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect(board.merges).toHaveLength(1)
  })
})

describe('rework', () => {
  it('restarts after the reviewer requests changes', async () => {
    const { board, cycle, runs, harness, workspaces } = setup()
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    board.updatePullRequest('1', { review: 'changes_requested', feedback: ['Use bcrypt for passwords.'] })

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge', '1:implement', '1:merge'])
    expect(stageRuns(harness)[2]?.prompt).toContain('Use bcrypt for passwords.')
    expect(workspaces.resets).toEqual(['1'])
    expect(await board.pullRequest('1')).toMatchObject({ state: 'open', review: 'none' })
    expect((await board.getTask('1'))?.state).toBe('review')
  })

  it('restarts when a human sets the rework state, with the comments as feedback', async () => {
    const { board, cycle, harness } = setup()
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    await board.addComment('1', 'Please split the controller.')
    await board.setState('1', 'rework')

    await cycle()

    expect(stageRuns(harness)[2]?.stage).toBe('implement')
    expect(stageRuns(harness)[2]?.prompt).toContain('Please split the controller.')
  })
})
