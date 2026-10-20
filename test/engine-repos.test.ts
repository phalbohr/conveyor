import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

function setup(options: { mode?: 'human' | 'ai'; script?: Script; extra?: string } = {}) {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(
    join(settings, 'config.yaml'),
    [
      'board: {provider: gitlab, project: shop/frontend, group: shop}',
      'repos: {include: [frontend, user-service]}',
      'pickup_from: story',
      `transitions: {merge: ${options.mode ?? 'ai'}, story_to_plan: autonomous}`,
      'stages:\n  plan: {}\n  implement: {}\n  merge: {}',
      options.extra ?? '',
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

  it('collects the parts in one draft merge request per repository and asks for review of all after the last part', async () => {
    const { board, workspaces, cycle } = setup({
      mode: 'human',
      extra: 'parts: together',
      script: (run) => (run.stage === 'plan' ? { ...done, repos: ['user-service', 'frontend'], parts: ['API', 'Screen'] } : done),
    })
    workspaces.changedRepos = ['user-service']
    await board.createTask('Checkout', 'story', { form: 'story' })

    await cycle()
    expect(await board.pullRequest('1', 'user-service')).toMatchObject({ state: 'open', draft: true })
    expect(await board.pullRequest('1', 'frontend')).toBeUndefined()
    expect((await board.listComments('1')).some((comment) => comment.body.includes('**Draft merge requests for all parts of this task:**'))).toBe(true)

    workspaces.changedRepos = ['frontend', 'user-service']
    await cycle()
    expect(board.readied.map((entry) => entry.repo)).toEqual(['user-service', 'frontend'])
    expect(await board.pullRequest('1', 'frontend')).toMatchObject({ state: 'open' })
    expect((await board.pullRequest('1', 'frontend'))?.draft).toBeUndefined()
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.merges).toEqual([])
  })

  it('keeps an approval given after a new commit that the conveyor notices only later', async () => {
    const { board, workspaces, cycle } = setup({ mode: 'human' })
    workspaces.repoContains = async () => false
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('review')
    const pushed = new Date(Date.now() - 2_000).toISOString()
    const approved = new Date(Date.now() - 1_000).toISOString()
    board.updatePullRequest('1', { headSha: 'c'.repeat(40), headAt: pushed }, 'frontend')
    for (const repo of ['frontend', 'user-service']) board.updatePullRequest('1', { reviews: [{ author: 'alice', state: 'approved', body: '', submittedAt: approved }] }, repo)

    await cycle()
    expect((await board.listComments('1')).at(-1)?.body).toContain('from before this change no longer count; approvals given after it count')
    await cycle()
    expect(board.merges.map((merge) => merge.repo)).toEqual(['user-service', 'frontend'])
  })

  it('leaves a red base after the merge to the team when the merge request did not run the failing job, with checks.fix_base own', async () => {
    const { board, cycle, logs } = setup({ extra: 'checks: {fix_base: own}' })
    board.baseChecks = ['failure']
    for (const repo of ['frontend', 'user-service']) {
      board.checkNames.set(`merged-${repo}-1`.padEnd(40, '0'), { failed: ['update_parent_repo'] })
      board.checkNames.set(`${repo}-1`.padStart(40, '0'), { passed: ['build', 'test'] })
    }
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('done')
    expect((await board.listTasks()).some((task) => task.title.startsWith('Fix the CI'))).toBe(false)
    expect(logs.filter((line) => line.includes('so the conveyor leaves it to the team'))).toHaveLength(2)
  })

  it('merges no repository while a later one in the order still has to be rebased', async () => {
    const { board, workspaces, cycle, logs } = setup()
    workspaces.repoSyncs.set('frontend', ['rebased'])
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    expect(board.merges).toEqual([])
    expect(logs.join('\n')).toContain('the base branch of frontend moved; the branch is rebased onto it and waits for CI')
  })

  it('opens a merge request for a repository that only a later change touched, and asks for its review before merging', async () => {
    const { board, workspaces, cycle } = setup({ mode: 'human' })
    workspaces.changedRepos = ['frontend']
    await board.createTask('Copy change', 'story', { form: 'story' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('review')
    board.updatePullRequest('1', { reviews: [{ author: 'alice', state: 'approved', body: '', submittedAt: new Date(Date.now() + 1_000).toISOString() }] }, 'frontend')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    workspaces.changedRepos = ['frontend', 'user-service']
    await cycle()
    expect(board.merges).toEqual([])
    expect(await board.pullRequest('1', 'user-service')).toMatchObject({ state: 'open' })
    expect((await board.getTask('1'))?.state).toBe('review')
    expect((await board.listComments('1')).at(-1)?.body).toContain('**A repair changed more repositories.**')
  })

  it('takes no task whose author cannot write to every repository of the feature', async () => {
    const { board, cycle, logs, harness } = setup()
    board.repoOutsiders.set('user-service', new Set(['mallory']))
    await board.createTaskAs('mallory', 'Checkout', 'story', { form: 'story' })
    await cycle()
    expect(stageRuns(harness)).toEqual([])
    expect(logs).toContain('task 1: skipped: its author @mallory has no write access to every repository of the feature')
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

  it('waits for CI to start in every repository on its own clock', async () => {
    const { board, cycle, expireRetry } = setup()
    board.checks = 'none'
    await board.createTask('Checkout', 'story', { form: 'story' })
    await cycle()
    expect(board.merges).toEqual([])
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (const minutes of [2, 4, 6, 8, 10, 12]) {
        vi.setSystemTime(Date.now() + 2 * 60_000)
        await expireRetry()
        await cycle()
        if (board.merges.length === 2) break
        expect(minutes).toBeLessThan(12)
      }
    } finally {
      vi.useRealTimers()
    }
    expect(board.merges.map((merge) => merge.repo)).toEqual(['user-service', 'frontend'])
  })
})
