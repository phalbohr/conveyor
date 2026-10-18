import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine/engine.js'
import { renderWorkpad } from '../src/engine/workpad.js'
import type { Script } from '../src/harness/fake.js'
import { failed, type StageResult } from '../src/harness/harness.js'
import { UsageLedger } from '../src/usage.js'
import { FakeWorkspaces, deferred, stageHarness, stageRuns } from './fakes.js'
import { tempDir } from './helpers.js'

const done: StageResult = { outcome: 'done', summary: 'ok' }

function setup(options: { mode?: 'human' | 'ai' | 'smart'; plan?: 'autonomous'; stages?: string; config?: string; limits?: string; script?: Script; board?: string; repo?: string } = {}) {
  const settings = tempDir('conveyor-settings-')
  writeFileSync(
    join(settings, 'config.yaml'),
    [
      options.board ?? 'board: {provider: github, project: acme/app}',
      `transitions: {merge: ${options.mode ?? 'human'}${options.plan ? `, story_to_plan: ${options.plan}` : ''}}`,
      'stages:',
      options.stages ?? '  implement: {}\n  merge: {}',
      options.config ?? '',
    ].join('\n'),
  )
  writeFileSync(join(settings, 'local.yaml'), `limits: {awaiting_review: 10${options.limits ? `, ${options.limits}` : ''}}\n`)
  mkdirSync(join(settings, 'stages'))
  const board = new FakeBoard('me')
  const harness = stageHarness(options.script)
  const workspaces = new FakeWorkspaces()
  const logs: string[] = []
  const engine = new Engine({
    board,
    log: (message) => logs.push(message),
    harnesses: { claude: harness },
    workspaces,
    settingsDir: settings,
    repo: options.repo ?? tempDir(),
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
  return { board, harness, workspaces, engine, cycle, runs, expireRetry, logs }
}

describe('merge mode human', () => {
  it('opens a pull request after the merge stage and waits for review', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect(await board.pullRequest('1')).toMatchObject({ state: 'open' })
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.merges).toEqual([])
  })

  it('stops with an error when the pull request cannot be opened, instead of running the merge stage again', async () => {
    const { board, cycle, runs } = setup()
    board.openPullRequest = async () => {
      throw new Error('glab api POST merge_requests failed: source_branch does not exist')
    }
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    const error = (await board.listComments('1')).find((comment) => comment.body.includes('conveyor:error'))?.body ?? ''
    expect(error).toContain('The pull request was not opened.')
    expect(error).toContain('source_branch does not exist')
  })

  it('takes no issue of another project of a group board without repos, and stops a started one', async () => {
    const repo = tempDir()
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@gitlab.example:shop/frontend.git'])
    const { board, cycle, runs, logs } = setup({ board: 'board: {provider: gitlab, project: shop/frontend, group: shop}', repo })
    const projects: Record<string, string> = { '1': 'shop/frontend', '2': 'shop/backend', '3': 'shop/backend' }
    board.reference = (id) => `${projects[id]}#${id}`
    await board.createTask('Frontend', 'p', { form: 'plan' })
    await board.createTask('Backend', 'p', { form: 'plan' })
    const started = await board.createTask('Started backend', 'p', { form: 'plan' })
    await board.setOwner(started.id, await board.user())
    await board.setState(started.id, 'in-progress')

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect((await board.getTask('2'))?.owner).toBeUndefined()
    expect(logs.filter((line) => line.startsWith('task 2: skipped: the issue belongs to the project shop/backend, but the conveyor works in a clone of shop/frontend'))).toHaveLength(1)
    expect((await board.getTask('3'))?.state).toBe('needs-input')
    expect((await board.listComments('3')).some((comment) => comment.body.includes('needs `repos` in config.yaml'))).toBe(true)
  })

  it('finishes the task after a human merges the pull request', async () => {
    const { board, cycle, runs, workspaces } = setup({
      stages: '  implement: {}\n  merge: {}\n  verify: {when: success}\n  fix-ci: {when: failure}',
    })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    board.updatePullRequest('1', { state: 'merged' })

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge', '1:verify'])
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: false })
    expect(await board.claim('1')).toBe(true)
    expect(workspaces.removed).toEqual(['1'])
    expect(workspaces.deletedBranches).toEqual(['1'])
  })

  it('leaves a done task open by default and does not take it again', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/approve')
    await cycle()
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: false })
    expect(await board.claim('1')).toBe(true)
    await board.release('1')

    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge'])
  })

  it('closes a done task with close_on_done', async () => {
    const { board, cycle } = setup({ config: 'close_on_done: true' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/approve')
    await cycle()
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: true })
  })

  it('does not take /merge as an approval', async () => {
    const { board, cycle } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/merge')
    await cycle()
    expect(board.merges).toEqual([])
    expect((await board.getTask('1'))?.state).toBe('review')
  })

  it('keeps waiting for a plain comment', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', 'Looks good so far, I will check it tomorrow.')
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.merges).toEqual([])
  })

  it('merges after a /approve comment on the issue', async () => {
    const { board, cycle } = setup({ stages: '  implement: {}\n  merge: {}\n  verify: {when: success}' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/approve')
    await cycle()
    expect(board.merges).toHaveLength(1)
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: false })
  })

  it('ignores approvals from the conveyor account when count_own_approvals is off', async () => {
    const { board, cycle } = setup({ config: 'review: {count_own_approvals: false}' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/approve')
    await cycle()
    expect(board.merges).toEqual([])
    await board.addCommentAs('alice', '1', '/approve')
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('merges after a /approve comment on the pull request', async () => {
    const { board, cycle } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    board.updatePullRequest('1', { comments: [{ author: 'alice', body: '/approve looks right', createdAt: new Date().toISOString() }] })
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('waits for the configured number of distinct approvals', async () => {
    const { board, cycle } = setup({ config: 'review: {approvals: 2}' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/approve')
    await board.addComment('1', '/approve again')
    await cycle()
    expect(board.merges).toEqual([])

    board.updatePullRequest('1', { reviews: [{ author: 'alice', state: 'approved', body: '', submittedAt: new Date().toISOString() }] })
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('lets a /rework comment on the pull request win over approvals', async () => {
    const { board, cycle, harness } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/approve')
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
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect(board.merges).toEqual([{ id: '1', method: 'squash' }])
    expect(await board.getTask('1')).toMatchObject({ state: 'done', closed: false })
  })

  it('waits for checks to start before it merges a pull request without checks', async () => {
    const { board, cycle, expireRetry } = setup({ mode: 'ai' })
    board.checks = 'none'
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect(board.merges).toEqual([])
    expect(await board.listComments('1').then((comments) => comments.find((c) => c.body.includes('conveyor:workpad'))?.body)).toContain('checksWait')

    await expireRetry()
    await cycle()
    expect(board.merges).toEqual([])

    const pad = (await board.listComments('1')).find((c) => c.body.includes('conveyor:workpad'))
    if (pad) await board.updateComment(pad.id, pad.body.replace(/"since":"[^"]+"/, '"since":"2000-01-01T00:00:00.000Z"'))
    await expireRetry()
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('sends a task with failed checks back to a stage on /fix_from', async () => {
    const { board, harness, cycle } = setup({ mode: 'ai' })
    board.checks = 'failure'
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('needs-input')

    await board.addComment('1', '/fix_from: implement The backend migration V24 clashes with another task.')
    await cycle()

    const again = stageRuns(harness).filter((run) => run.stage === 'implement').at(-1)
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['implement', 'merge', 'implement', 'merge'])
    expect(again?.prompt).toContain('The merge failed: checks failed')
    expect(again?.prompt).toContain('migration V24 clashes')
  })

  it('waits for open blockers before merging', async () => {
    const { board, cycle, expireRetry } = setup({
      mode: 'ai',
      script: async (run) => {
        if (run.stage === 'implement') await board.addBlocker('1', '2')
        return done
      },
    })
    await board.createTask('Feature', 'p', { form: 'plan' })
    await board.createTask('Foundation', 'p', { form: 'story' })
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
    await board.createTask('Add login', 'p', { form: 'plan' })
    await board.openPullRequest('1', 'Add login', '')
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
    await board.createTask('Add login', 'p', { form: 'plan' })
    await board.openPullRequest('1', 'Add login', '')

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
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    expect((await board.listComments('1')).at(-1)?.body).toContain('merge conflict')
  })

  it('waits while another workstation merges', async () => {
    const { board, cycle, expireRetry } = setup({ mode: 'ai' })
    await board.claim('merge')
    await board.createTask('Add login', 'p', { form: 'plan' })
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
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('review')
    expect(board.merges).toEqual([])
    expect(stageRuns(harness)[1]?.prompt).toContain('human review')
  })

  it('merges when the merge stage returns done', async () => {
    const { board, cycle } = setup({ mode: 'smart' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect(board.merges).toHaveLength(1)
  })
})

describe('fix and rework', () => {
  const now = () => new Date().toISOString()

  it('fixes on the existing branch from the plan stage after a Request changes review', async () => {
    const { board, cycle, runs, harness, workspaces } = setup({ plan: 'autonomous' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    const pull = await board.pullRequest('1')
    board.updatePullRequest('1', {
      reviews: [{ author: 'alice', state: 'changes_requested', body: 'Use bcrypt for passwords.', submittedAt: now() }],
      feedback: [{ author: 'alice', body: 'Use bcrypt for passwords.' }],
    })

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge', '1:plan', '1:implement', '1:merge'])
    expect(stageRuns(harness)[2]?.prompt).toContain('Use bcrypt for passwords.')
    expect(stageRuns(harness)[2]?.prompt).toContain('existing branch')
    expect(workspaces.resets).toEqual([])
    expect(await board.pullRequest('1')).toMatchObject({ number: pull?.number, state: 'open' })
    expect((await board.getTask('1'))?.state).toBe('review')
  })

  it('fixes from the plan stage after a /fix comment', async () => {
    const { board, cycle, runs } = setup({ plan: 'autonomous' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/fix Rename the helper.')
    await cycle()
    expect(runs().slice(2)).toEqual(['1:plan', '1:implement', '1:merge'])
  })

  it('fixes from the named stage after a /fix_from comment', async () => {
    const { board, cycle, runs, harness } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/fix_from: merge Remove the extra comments.')
    await cycle()
    expect(runs().slice(2)).toEqual(['1:merge'])
    expect(stageRuns(harness)[2]?.prompt).toContain('Remove the extra comments.')
    expect(stageRuns(harness)[2]?.prompt).not.toContain('/fix_from')
  })

  it('answers once when /fix_from names an unknown stage', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', '/fix_from: deploy now')
    await cycle()
    await cycle()
    const errors = (await board.listComments('1')).filter((c) => c.body.includes('deploy') && c.body.startsWith('<!-- conveyor'))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.body).toContain('implement')
    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect((await board.getTask('1'))?.state).toBe('review')
  })

  it('ignores reviews from before the task entered review', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    board.updatePullRequest('1', { reviews: [{ author: 'alice', state: 'changes_requested', body: 'old', submittedAt: '2000-01-01T00:00:00.000Z' }] })
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge'])
  })

  it('restarts from a fresh branch after a /rework comment', async () => {
    const { board, cycle, runs, harness, workspaces } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    const pull = await board.pullRequest('1')
    await board.addComment('1', '/rework Use a different storage approach.')

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:merge', '1:implement', '1:merge'])
    expect(stageRuns(harness)[2]?.prompt).toContain('Use a different storage approach.')
    expect(stageRuns(harness)[2]?.prompt).toContain('fresh branch')
    expect(workspaces.resets).toEqual(['1'])
    expect((await board.pullRequest('1'))?.number).not.toBe(pull?.number)
  })

  it('restarts when a human sets the rework state, with the comments as feedback', async () => {
    const { board, cycle, harness } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    await board.addComment('1', 'Please split the controller.')
    await board.setState('1', 'rework')

    await cycle()

    expect(stageRuns(harness)[2]?.stage).toBe('implement')
    expect(stageRuns(harness)[2]?.prompt).toContain('Please split the controller.')
  })
})

describe('merge against the latest base branch', () => {
  it('rebases a branch that fell behind, waits for its new checks, then merges', async () => {
    const { board, workspaces, cycle, expireRetry } = setup({ mode: 'ai' })
    workspaces.syncs = ['rebased', 'current']
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect(board.merges).toEqual([])
    expect(workspaces.pushes.length).toBeGreaterThan(1)

    await expireRetry()
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('rebases a branch with failed checks onto a newer base before it repairs anything', async () => {
    const { board, workspaces, cycle, expireRetry, runs } = setup({ mode: 'ai', stages: '  implement: {}\n  merge: {}\n  fix-ci: {when: failure}' })
    board.checks = 'failure'
    workspaces.syncs = ['rebased']
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect(board.merges).toEqual([])

    board.updatePullRequest('1', { checks: 'success' })
    await expireRetry()
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect(board.merges).toHaveLength(1)
  })

  it('pushes commits that a failed push left behind before it judges the checks', async () => {
    const { board, workspaces, cycle, expireRetry, runs } = setup({ mode: 'ai', stages: '  implement: {}\n  merge: {}\n  fix-ci: {when: failure}' })
    board.draft = true
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    const pushes = workspaces.pushes.length

    board.ready('1')
    board.updatePullRequest('1', { checks: 'failure' })
    workspaces.heads.set('1', 'f'.repeat(40))
    await expireRetry()
    await cycle()
    expect(workspaces.pushes.length).toBe(pushes + 1)
    expect(runs()).toEqual(['1:implement', '1:merge'])
    expect(board.merges).toEqual([])

    workspaces.heads.set('1', '1'.padStart(40, '0'))
    board.updatePullRequest('1', { checks: 'success' })
    await expireRetry()
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('does not push a local branch that diverged from the pull request head', async () => {
    const { board, workspaces, cycle, expireRetry } = setup({ mode: 'ai' })
    board.draft = true
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    const pushes = workspaces.pushes.length

    board.ready('1')
    workspaces.heads.set('1', 'f'.repeat(40))
    workspaces.containsRemote = false
    await expireRetry()
    await cycle()
    expect(workspaces.pushes.length).toBe(pushes)
    expect(board.merges).toHaveLength(1)
  })

  it('asks for a new review after it pushes left-behind commits of an approved task', async () => {
    const { board, workspaces, cycle } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    workspaces.heads.set('1', 'f'.repeat(40))
    await board.addComment('1', '/approve')
    await cycle()
    expect(board.merges).toEqual([])
    expect((await board.getTask('1'))?.state).toBe('review')
    expect((await board.listComments('1')).at(-1)?.body).toContain('after the review request')
  })

  it('sends a branch that conflicts with the new base back to the merge stage', async () => {
    const { board, harness, workspaces, cycle } = setup({ mode: 'ai' })
    workspaces.syncs = ['conflict', 'current']
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect(board.merges).toEqual([])
    await cycle()

    const merges = stageRuns(harness).filter((run) => run.stage === 'merge')
    expect(merges).toHaveLength(2)
    expect(merges[1]?.prompt).toContain('no longer rebases onto it without conflicts')
    expect(board.merges).toHaveLength(1)
  })
})

describe('the base branch after the merge', () => {
  it('waits for the CI of the merge commit before the task is done', async () => {
    const { board, cycle, expireRetry } = setup({ mode: 'ai' })
    board.baseChecks = ['pending', 'success']
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect(board.merges).toHaveLength(1)
    expect((await board.getTask('1'))?.state).toBe('in-progress')

    await expireRetry()
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('done')
  })

  it('asks a human when the base CI fails and no repair stage exists', async () => {
    const { board, cycle } = setup({ mode: 'ai' })
    board.baseChecks = ['failure']
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    expect((await board.listComments('1')).at(-1)?.body).toContain('The base branch CI failed after this task was merged')

    await board.addComment('1', 'Known flaky job, fine.')
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('done')
  })

  it('leaves the base to a fix task when the merged task has no repair stage', async () => {
    const { board, cycle } = setup({ mode: 'ai' })
    board.baseChecks = ['failure']
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect((await board.getTask('1'))?.fixing).toBeFalsy()

    board.headChecks = 'failure'
    await cycle()
    const fix = (await board.listTasks()).find((task) => task.title.startsWith('Fix the CI of the base branch'))
    expect(fix?.fixing).toBe(true)
  })

  it('retries the repair when another workstation holds the fix lock', async () => {
    const { board, cycle, runs, logs, expireRetry } = setup({ mode: 'ai', stages: '  implement: {}\n  merge: {}\n  fix-ci: {when: failure}' })
    board.baseChecks = ['failure']
    await board.claim('fix')
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect(logs).toContain('task 1: another workstation chooses the task that fixes the CI; it checks again')
    expect((await board.getTask('1'))?.state).toBe('in-progress')

    await board.release('fix')
    await expireRetry()
    await cycle()
    expect(runs()).toContain('1:fix-ci')
  })

  it('runs the repair stage from the latest base and merges a follow-up pull request', async () => {
    const { board, harness, workspaces, cycle } = setup({ mode: 'ai', stages: '  implement: {}\n  merge: {}\n  fix-ci: {when: failure}' })
    board.baseChecks = ['failure', 'success']
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    await cycle()

    const repair = stageRuns(harness).find((run) => run.stage === 'fix-ci')
    expect(repair?.prompt).toContain('The base branch CI failed after this task was merged')
    expect(workspaces.resets).toContain('1')
    expect(board.pullTitles.at(-1)).toBe('Fix the base branch after: Add login')
    expect(board.merges).toHaveLength(2)
    expect((await board.getTask('1'))?.state).toBe('done')
  })
})

describe('a task without changes', () => {
  it('finishes without a pull request when the branch has no changes against the base', async () => {
    const { board, workspaces, cycle } = setup({ mode: 'ai' })
    workspaces.aheadBy = 0
    await board.createTask('Already done', 'p', { form: 'plan' })

    await cycle()

    expect(board.pullTitles).toEqual([])
    expect(board.merges).toEqual([])
    expect((await board.getTask('1'))?.state).toBe('done')
    expect((await board.listComments('1')).some((comment) => comment.body.includes('Nothing to merge'))).toBe(true)
  })
})

describe('a red base branch', () => {
  it('does not take an issue of someone else with the hidden marker as the fix task', async () => {
    const { board, cycle } = setup({ mode: 'ai' })
    board.headChecks = 'failure'
    await board.createTaskAs('alice', 'Looks like a fix', '<!-- conveyor:base-fix -->', { state: 'backlog' })
    await cycle()
    const fixes = (await board.listTasks()).filter((task) => task.title.startsWith('Fix the CI of the base branch'))
    expect(fixes).toHaveLength(1)
    expect(fixes[0]?.author).toBe('me')
  })

  it('with checks.fix_base own, reports a base it did not break and neither fixes it nor waits', async () => {
    const { board, cycle, logs } = setup({ mode: 'ai', config: 'checks: {fix_base: own}' })
    board.headChecks = 'failure'
    board.baseFailures = ['deploy:catalog']
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    await cycle()

    expect((await board.listTasks()).some((task) => task.title.startsWith('Fix the CI'))).toBe(false)
    expect(board.merges.map((merge) => merge.id)).toEqual(['1'])
    expect(logs.filter((line) => line.includes('checks.fix_base is own, so the conveyor fixes only failures after its own merges'))).toHaveLength(1)
    expect(logs.join('\n')).toContain('(deploy:catalog)')
  })

  it('with checks.fix_base own, still repairs a base its own merge broke', async () => {
    const { board, cycle } = setup({ mode: 'ai', config: 'checks: {fix_base: own}' })
    board.baseChecks = ['failure']
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    expect((await board.listComments('1')).at(-1)?.body).toContain('The base branch CI failed after this task was merged')
  })

  it('with checks.fix_base none, finishes a task whose merge broke the base and leaves the base to the team', async () => {
    const { board, cycle } = setup({ mode: 'ai', config: 'checks: {fix_base: none}' })
    board.baseChecks = ['failure']
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('done')
    expect((await board.listComments('1')).some((comment) => comment.body.includes('`checks.fix_base` is `none`, so the conveyor does not repair it'))).toBe(true)
    board.headChecks = 'failure'
    await board.createTask('Next', 'p', { form: 'plan' })
    await cycle()
    expect((await board.listTasks()).some((task) => task.title.startsWith('Fix the CI'))).toBe(false)
    expect(board.merges.map((merge) => merge.id)).toEqual(['1', '2'])
  })

  it('creates one fix task, merges it first, and holds the other merges until the base is green', async () => {
    const { board, harness, cycle } = setup({ mode: 'ai' })
    board.headChecks = 'failure'
    board.baseFailures = ['Backend (Java 21)']
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    const fix = (await board.listTasks()).find((task) => task.title.startsWith('Fix the CI of the base branch'))
    expect(fix?.body).toContain('Backend (Java 21)')
    expect(fix?.priority).toBe(1)
    expect(board.merges.map((merge) => merge.id)).toEqual([fix?.id])
    expect(stageRuns(harness).filter((run) => run.taskId === '1')).toEqual([])

    await cycle()
    expect((await board.listTasks()).filter((task) => task.title.startsWith('Fix the CI')).length).toBe(1)
    expect(stageRuns(harness).filter((run) => run.taskId === '1')).toEqual([])

    board.headChecks = 'success'
    await cycle()
    expect(board.merges.map((merge) => merge.id)).toEqual([fix?.id, '1'])
  })
})

describe('slots while the base is red', () => {
  const fixOf = async (board: FakeBoard) => (await board.listTasks()).find((task) => task.title.startsWith('Fix the CI of the base branch'))

  it('frees the slots of tasks that wait to merge so the fix task runs', async () => {
    const { board, cycle } = setup({ mode: 'ai', limits: 'running: 2' })
    board.draft = true
    await board.createTask('Add login', 'p', { form: 'plan' })
    await board.createTask('Add search', 'p', { form: 'plan' })
    await cycle()
    expect(board.merges).toEqual([])

    board.draft = false
    board.headChecks = 'failure'
    await cycle()
    const fix = await fixOf(board)
    expect(board.merges.map((merge) => merge.id)).toEqual([fix?.id])
  })

  it('starts the fix task when every slot is taken', async () => {
    const { board, cycle } = setup({ mode: 'ai', limits: 'running: 1', script: (run) => (run.taskId === '1' ? failed('boom') : done) })
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect((await board.getTask('1'))?.state).toBe('in-progress')

    board.headChecks = 'failure'
    await cycle()
    const fix = await fixOf(board)
    expect(board.merges.map((merge) => merge.id)).toEqual([fix?.id])
  })
})

describe('one repair at a time', () => {
  it('lets one task repair its failed checks while the others wait, then retries the others on the new base', async () => {
    const { board, cycle, runs, expireRetry } = setup({
      mode: 'ai',
      limits: 'running: 2',
      stages: '  implement: {}\n  merge: {}\n  fix-ci: {when: failure}',
      script: (run) => {
        if (run.stage === 'fix-ci') board.updatePullRequest(run.taskId ?? '', { checks: 'success' })
        return done
      },
    })
    board.checks = 'failure'
    await board.createTask('Add login', 'p', { form: 'plan' })
    await board.createTask('Add search', 'p', { form: 'plan' })

    await cycle()
    const repairs = () => runs().filter((run) => run.endsWith(':fix-ci'))
    expect(repairs()).toHaveLength(1)
    const [first] = repairs()
    const other = first === '1:fix-ci' ? '2' : '1'
    expect(board.merges).toEqual([])

    await cycle()
    expect(board.merges.map((merge) => merge.id)).toEqual([first?.split(':')[0]])
    expect(repairs()).toHaveLength(1)

    await expireRetry(other)
    await cycle()
    expect(repairs()).toEqual([first, `${other}:fix-ci`])
    await cycle()
    expect(board.merges).toHaveLength(2)
    expect((await board.listTasks()).filter((task) => task.fixing)).toEqual([])
  })

  it('waits while a task of another member fixes the CI on their workstation', async () => {
    const { board, cycle, runs, logs, expireRetry } = setup({ mode: 'ai' })
    const theirs = await board.createTaskAs('alice', 'Search', 'p', { state: 'in-progress' })
    await board.setOwner(theirs.id, 'alice')
    await board.setFixing(theirs.id, true)
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect(runs()).toEqual(['2:implement'])
    expect(logs).toContain('CI freeze: task #1 fixes the CI; merges wait')
    expect(logs).toContain('task 2: stops before stage merge; task #1 fixes the CI first')

    await board.setFixing(theirs.id, false)
    await expireRetry('2')
    await cycle()
    expect(runs()).toEqual(['2:implement', '2:merge'])
    expect(board.merges).toHaveLength(1)
    expect(logs).toContain('CI freeze over: task #1 no longer fixes the CI; merges continue')
  })

  it('lets a started task work up to merge while the base is red, and tells it where the failures come from', async () => {
    const { board, cycle, runs, harness } = setup({ mode: 'ai', stages: '  implement: {}\n  review: {}\n  merge: {}' })
    const started = await board.createTask('Add login', 'p', { state: 'in-progress' })
    await board.setOwner(started.id, 'me')
    await board.addComment(started.id, renderWorkpad({ attempt: 0, stage: 'implement' }, ''))
    board.headChecks = 'failure'
    board.baseFailures = ['Backend (Java 21)']
    const theirs = await board.createTaskAs('alice', 'Fix the CI of the base branch main', 'p', { state: 'in-progress' })
    await board.setOwner(theirs.id, 'alice')
    await board.setFixing(theirs.id, true)
    await board.createTask('Add search', 'p', { form: 'plan' })

    await cycle()
    expect(runs()).toEqual(['1:implement', '1:review'])
    expect(stageRuns(harness)[0]?.prompt).toContain('## Base branch\n\nThe CI of the base branch fails at')
    expect(stageRuns(harness)[0]?.prompt).toContain(`(Backend (Java 21)), and this task did not cause it. Task #${theirs.id} fixes it`)
    expect(board.merges).toEqual([])
  })

  it('takes the fix task of another member for a red base instead of creating a second one', async () => {
    const { board, cycle, runs } = setup({ mode: 'ai' })
    board.headChecks = 'failure'
    const theirs = await board.createTaskAs('alice', 'Fix the CI of the base branch main', 'p', { state: 'in-progress' })
    await board.setOwner(theirs.id, 'alice')
    await board.setFixing(theirs.id, true)
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect((await board.listTasks()).filter((task) => task.title.startsWith('Fix the CI'))).toHaveLength(1)
    expect(runs()).toEqual([])
  })

  it('keeps the freeze on its own workstation while the fixer runs', async () => {
    const gate = deferred<StageResult>()
    const { board, engine, logs, expireRetry } = setup({ mode: 'ai', limits: 'running: 2', script: (run) => (run.taskId === '1' ? gate.promise : done) })
    const fixer = await board.createTask('Fix the flaky test', 'p', { state: 'in-progress' })
    await board.setOwner(fixer.id, 'me')
    await board.addComment(fixer.id, renderWorkpad({ attempt: 0, stage: 'implement' }, ''))
    await board.setFixing(fixer.id, true)
    await board.createTask('Add login', 'p', { form: 'plan' })

    await engine.tick()
    await vi.waitFor(() => expect(logs).toContain('task 2: stops before stage merge; task #1 fixes the CI first'))
    await expireRetry('2')
    await engine.tick()
    await vi.waitFor(() => expect(logs.filter((line) => line === 'task 2: stops before stage merge; task #1 fixes the CI first')).toHaveLength(2))
    expect(board.merges).toEqual([])
    expect(logs.filter((line) => line.startsWith('CI freeze over'))).toEqual([])
    gate.resolve(done)
    await engine.idle()
  })

  it('takes the fix label only for failed checks, not for a conflict', async () => {
    const { board, cycle, runs, expireRetry } = setup({
      mode: 'ai',
      stages: '  implement: {}\n  merge: {}\n  fix-ci: {when: failure}',
      script: (run) => {
        if (run.stage === 'fix-ci') board.updatePullRequest('1', { mergeable: 'yes' })
        return done
      },
    })
    board.draft = true
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    board.ready('1')
    board.updatePullRequest('1', { mergeable: 'no' })
    await expireRetry()
    await cycle()
    expect(runs()).toContain('1:fix-ci')
    expect((await board.getTask('1'))?.fixing).toBeFalsy()
  })

  it('ignores the fix label on an issue that is not on the board', async () => {
    const { board, cycle, runs } = setup({ mode: 'ai' })
    const stray = await board.createTaskAs('alice', 'Notes', 'p')
    await board.setFixing(stray.id, true)
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect(runs()).toEqual(['2:implement', '2:merge'])
  })

  it('notices that the fix task of a red base was reset and chooses a new one', async () => {
    const { board, cycle } = setup({ mode: 'ai' })
    board.headChecks = 'failure'
    const theirs = await board.createTaskAs('alice', 'Fix the CI of the base branch main', 'p', { state: 'in-progress' })
    await board.setOwner(theirs.id, 'alice')
    await board.setFixing(theirs.id, true)
    await cycle()
    expect((await board.listTasks()).filter((task) => task.title.startsWith('Fix the CI'))).toHaveLength(1)

    await board.setFixing(theirs.id, false)
    await board.setOwner(theirs.id, undefined)
    await board.setState(theirs.id, 'backlog')
    await cycle()
    const fixes = (await board.listTasks()).filter((task) => task.title.startsWith('Fix the CI'))
    expect(fixes).toHaveLength(2)
    expect(fixes[1]?.author).toBe('me')
  })

  it('ignores the fix label on a task of an outsider', async () => {
    const { board, cycle, runs } = setup({ mode: 'ai' })
    board.outsiders.add('mallory')
    const planted = await board.createTaskAs('mallory', 'Freeze it', 'p', { state: 'in-progress' })
    await board.setFixing(planted.id, true)
    await board.createTask('Add login', 'p', { form: 'plan' })

    await cycle()
    expect(runs()).toEqual(['2:implement', '2:merge'])
  })
})

describe('draft and foreign pull requests', () => {
  it('names the review commands with free-text notes when a task waits for review or after a failed merge', async () => {
    const { board, cycle } = setup()
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    const review = (await board.listComments('1')).at(-1)?.body ?? ''
    expect(review).toContain('**The pull request is ready for review:**')
    expect(review).toContain('`/approve` (1 approval needed)')
    expect(review).toContain('`/fix_from: <stage> <notes>`: the same from that stage (`story`, `plan`, `implement`, `merge`)')
    expect(review).toContain('`<notes>` is free text in your own words')

    const failing = setup({ mode: 'ai' })
    failing.board.checks = 'failure'
    await failing.board.createTask('Add search', 'p', { form: 'plan' })
    await failing.cycle()
    const error = (await failing.board.listComments('1')).at(-1)?.body ?? ''
    expect(error).toContain('**The merge failed.**')
    expect(error).toContain('reply with any comment to retry')
    expect(error).toContain('`/rework <notes>`: start over from `plan` on a new branch.')
  })

  it('does not merge a draft pull request until it is ready', async () => {
    const { board, cycle, expireRetry } = setup({ mode: 'ai' })
    board.draft = true
    await board.createTask('Add login', 'p', { form: 'plan' })
    await cycle()
    expect(board.merges).toEqual([])

    board.ready('1')
    await expireRetry()
    await cycle()
    expect(board.merges).toHaveLength(1)
  })

  it('asks before working next to a linked pull request and continues it on /continue', async () => {
    const { board, workspaces, harness, cycle } = setup({ mode: 'ai' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    board.linkedPullsOf.set('1', [{ number: '5', url: 'https://example.test/pull/5', branch: '1-add-login', draft: true, author: 'me' }])

    await cycle()
    expect(stageRuns(harness)).toEqual([])
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    expect((await board.listComments('1')).at(-1)?.body).toContain('already has a linked pull request')

    await board.addComment('1', '/continue')
    await cycle()
    expect(workspaces.sources).toEqual(['1:1-add-login'])
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['implement', 'merge'])
    expect(board.merges).toHaveLength(1)
  })

  it('ignores a linked pull request of an outsider and answers an unknown number', async () => {
    const { board, harness, cycle } = setup({ mode: 'ai' })
    board.outsiders.add('mallory')
    await board.createTask('Add login', 'p', { form: 'plan' })
    board.linkedPullsOf.set('1', [{ number: '6', url: 'https://example.test/pull/6', branch: 'evil', draft: false, author: 'mallory' }])
    await cycle()
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['implement', 'merge'])

    const second = setup({ mode: 'ai' })
    await second.board.createTask('Add search', 'p', { form: 'plan' })
    second.board.linkedPullsOf.set('1', [{ number: '5', url: 'https://example.test/pull/5', branch: '1-add-search', draft: false, author: 'me' }])
    await second.cycle()
    await second.board.addComment('1', '/continue 99')
    await second.cycle()
    expect((await second.board.listComments('1')).at(-1)?.body).toContain('There is no linked pull request 99.')
    expect(stageRuns(second.harness)).toEqual([])
  })

  it('starts from the base branch on /fresh', async () => {
    const { board, workspaces, harness, cycle } = setup({ mode: 'ai' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    board.linkedPullsOf.set('1', [{ number: '5', url: 'https://example.test/pull/5', branch: '1-add-login', draft: false, author: 'me' }])
    await cycle()
    await board.addComment('1', '/fresh')
    await cycle()
    expect(workspaces.sources).toEqual([])
    expect(stageRuns(harness).map((run) => run.stage)).toEqual(['implement', 'merge'])
  })

  it('starts a story at plan after the answer, although the form label is gone', async () => {
    const { board, harness, cycle } = setup({ mode: 'ai', plan: 'autonomous', config: 'pickup_from: story' })
    await board.createTask('Add login', 'a story', { form: 'story' })
    board.linkedPullsOf.set('1', [{ number: '5', url: 'https://example.test/pull/5', branch: '1-add-login', draft: false, author: 'me' }])
    await cycle()
    await board.addComment('1', '/fresh')
    await cycle()
    expect(stageRuns(harness).map((run) => run.stage)[0]).toBe('plan')
  })
})

describe('a red base after a merge', () => {
  it('lets the merged task repair the base instead of opening a second fix task', async () => {
    const { board, harness, cycle, expireRetry } = setup({ mode: 'ai', stages: '  implement: {}\n  merge: {}\n  fix-ci: {when: failure}' })
    await board.createTask('Add login', 'p', { form: 'plan' })
    board.baseSha = 'merged-1'.padEnd(40, '0')
    board.headChecks = 'pending'

    await cycle()
    board.headChecks = 'failure'
    await expireRetry()
    await cycle()
    await cycle()

    expect(stageRuns(harness).some((run) => run.stage === 'fix-ci')).toBe(true)
    expect((await board.listTasks()).some((task) => task.title.startsWith('Fix the CI of the base branch'))).toBe(false)
  })
})
