import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine/engine.js'
import type { Script } from '../src/harness/fake.js'
import type { StageResult } from '../src/harness/harness.js'
import { UsageLedger } from '../src/usage.js'
import { FakeRepoWorkspaces, stageHarness, stageRuns } from './fakes.js'
import { tempDir } from './helpers.js'

const done: StageResult = { outcome: 'done', summary: 'ok' }
const planned: Script = (run) => (run.stage === 'plan' ? { ...done, repos: ['user-service', 'frontend'] } : done)

function setup(options: { mode?: 'human' | 'ai'; script?: Script } = {}) {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(
    join(settings, 'config.yaml'),
    [
      'board: {provider: gitlab, project: shop/frontend, group: shop}',
      'repos: {include: [frontend, user-service]}',
      'pickup_from: story',
      `transitions: {merge: ${options.mode ?? 'ai'}, story_to_plan: autonomous}`,
      'stages:\n  plan: {}\n  implement: {}\n  merge: {}',
    ].join('\n'),
  )
  mkdirSync(join(settings, 'stages'))
  const board = new FakeBoard('me')
  const harness = stageHarness(options.script ?? planned)
  const workspaces = new FakeRepoWorkspaces()
  const logs: string[] = []
  const engine = new Engine({ board, harnesses: { claude: harness }, workspaces, settingsDir: settings, repo: tempDir(), home: tempDir(), usage: new UsageLedger(), loadConfig: () => loadConfig(settings), log: (message) => logs.push(message) })
  const cycle = async () => {
    await engine.tick()
    await engine.idle()
  }
  const expireRetry = async (id = '1') => {
    const pad = (await board.listComments(id)).find((comment) => comment.body.includes('conveyor:workpad'))
    if (pad) await board.updateComment(pad.id, pad.body.replace(/"retryAt":"[^"]+"/, '"retryAt":"2000-01-01T00:00:00.000Z"'))
  }
  return { board, harness, workspaces, engine, cycle, logs, expireRetry }
}

describe('a feature in several repositories', () => {
  it('opens one merge request per changed repository and merges them in the order of the plan', async () => {
    const { board, harness, cycle } = setup()
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    expect(stageRuns(harness)[0]?.prompt).toContain('## Repositories')
    expect(stageRuns(harness)[0]?.prompt).toContain('Return in `repos`')
    expect(board.merges.map((merge) => merge.repo)).toEqual(['user-service', 'frontend'])
    expect(board.pullBodies.every((body) => body.startsWith('Part of #1'))).toBe(true)
    expect((await board.getTask('1'))?.state).toBe('done')
  })

  it('opens merge requests only for the repositories the task changed', async () => {
    const { board, workspaces, cycle } = setup()
    workspaces.changedRepos = ['frontend']
    await board.createTask('Copy change', 'story', { form: 'story' })
    await cycle()
    expect(board.merges.map((merge) => merge.repo)).toEqual(['frontend'])
  })

  it('merges only after every merge request is approved on its own', async () => {
    const { board, cycle } = setup({ mode: 'human' })
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('review')
    const request = (await board.listComments('1')).at(-1)?.body ?? ''
    expect(request).toContain('**The merge requests are ready for review**')
    expect(request.indexOf('user-service')).toBeLessThan(request.indexOf('`frontend`'))
    const approve = (repo: string) => board.updatePullRequest('1', { comments: [{ author: 'alice', body: '/approve', createdAt: new Date().toISOString() }] }, repo)

    await board.addComment('1', '/approve')
    approve('frontend')
    await cycle()
    expect(board.merges).toEqual([])

    approve('user-service')
    await cycle()
    expect(board.merges.map((merge) => merge.repo)).toEqual(['user-service', 'frontend'])
  })

  it('merges nothing while the checks of one repository fail', async () => {
    const { board, cycle, logs, expireRetry } = setup()
    board.draft = true
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    expect(logs).toContain('task 1: merge waits: the merge request of user-service is a draft; mark it ready for review')
    board.ready('1', 'frontend')
    board.ready('1', 'user-service')
    board.updatePullRequest('1', { checks: 'failure' }, 'frontend')
    await expireRetry()
    await cycle()
    expect(board.merges).toEqual([])
    expect(logs).toContain('task 1: merge failed: checks failed in frontend')
  })

  it('keeps an earlier merge when a later merge request fails to merge and names the repository', async () => {
    const { board, cycle, logs } = setup()
    const merge = board.mergePullRequest.bind(board)
    board.mergePullRequest = async (id, method, sha, repo) => (repo === 'frontend' ? { ok: false, error: 'blocked by a rule' } : merge(id, method, sha, repo))
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    expect(board.merges.map((merge) => merge.repo)).toEqual(['user-service'])
    expect(logs).toContain('task 1: merge failed: frontend: blocked by a rule')
    expect((await board.listComments('1')).find((comment) => comment.body.includes('conveyor:workpad'))?.body).toContain('[user-service !')
  })

  it('asks for a new review when the branch of one repository changed after approval', async () => {
    const { board, cycle } = setup({ mode: 'human' })
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    board.updatePullRequest('1', { headSha: 'f'.repeat(40) }, 'frontend')
    await cycle()
    expect((await board.listComments('1')).at(-1)?.body).toContain('The branch of `frontend` changed to `fffffff`')
    expect(board.merges).toEqual([])
  })
})
