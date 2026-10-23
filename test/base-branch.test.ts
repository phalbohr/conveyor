import { describe, expect, it } from 'vitest'
import { GitHubBoard } from '../src/board/github.js'
import { GitLabBoard } from '../src/board/gitlab.js'
import type { Run } from '../src/cli.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

function recorder(stdout: (args: string[]) => string) {
  const calls: string[][] = []
  const run: Run = async (_command, args) => {
    calls.push(args)
    return { code: 0, stdout: stdout(args), stderr: '' }
  }
  return { run, calls }
}

describe('base branch', () => {
  it('takes the default branch of the repository without a setting', async () => {
    const { run } = recorder(() => JSON.stringify({ default_branch: 'trunk' }))
    expect(await new GitHubBoard('acme/app', run).baseBranch()).toBe('trunk')
    expect(await new GitLabBoard('acme/app', run).baseBranch()).toBe('trunk')
  })

  it('opens pull requests into the configured base branch', async () => {
    const { run, calls } = recorder((args) => (args[0] === 'pr' ? '[]' : '{}'))
    const board = new GitHubBoard('acme/app', run, { baseBranch: 'develop' })
    await expect(board.openPullRequest('5', 'Task', 'body')).rejects.toThrow('not found')
    const create = calls.find((args) => args[1] === 'create') ?? []
    expect(create[create.indexOf('--base') + 1]).toBe('develop')
    expect(calls.some((args) => args.includes('repos/acme/app'))).toBe(false)
  })

  it('opens merge requests into the configured base branch', async () => {
    const { run, calls } = recorder((args) => (args.some((arg) => arg.startsWith('users?')) ? '[{"id":7}]' : args.includes('user') ? '{"username":"me"}' : '[]'))
    await new GitLabBoard('acme/app', run, { baseBranch: 'develop', retryDelay: 0 }).openPullRequest('5', 'Task', 'body').catch(() => undefined)
    expect(calls.flat()).toContain('target_branch=develop')
    expect(calls.flat()).toContain('assignee_id=7')
  })

  it('accepts branch names only', () => {
    const config = (base: string) => {
      const dir = tempDir()
      writeFileSync(join(dir, 'config.yaml'), `board: {provider: github, project: acme/app, base_branch: ${JSON.stringify(base)}}\n`)
      return loadConfig(dir)
    }
    expect(config('release/2.0').ok).toBe(true)
    expect(config('--upload-pack=x').ok).toBe(false)
    expect(config('a b').ok).toBe(false)
  })
})

describe('GitHub blockers', () => {
  it('treats an existing blocked-by link as added', async () => {
    const { run } = recorder(() => JSON.stringify({ id: 99 }))
    const failing: Run = async (command, args) =>
      args.includes('POST') ? { code: 1, stdout: '', stderr: 'gh: Validation failed: Target issue has already been taken (HTTP 422)' } : run(command, args)
    await expect(new GitHubBoard('acme/app', failing).addBlocker('5', '4')).resolves.toBeUndefined()
  })
})

describe('draft pull requests', () => {
  it('opens a draft on GitHub, falls back to a Draft title where drafts are not available, and marks it ready', async () => {
    const pull = { number: 4, url: 'https://example.test/pull/4', headRefOid: 'a'.repeat(40), state: 'OPEN', mergeable: 'MERGEABLE', isCrossRepository: false, isDraft: true, statusCheckRollup: [], reviews: [], comments: [] }
    let created = false
    const calls: string[][] = []
    const run: Run = async (_command, args) => {
      calls.push(args)
      if (args[1] === 'create' && args.includes('--draft')) return { code: 1, stdout: '', stderr: 'Draft pull requests are not supported in this repository.' }
      if (args[1] === 'create') created = true
      const stdout = args[0] === 'pr' && args[1] === 'list' ? JSON.stringify(created ? [pull] : []) : args.includes('user') ? '{"login":"me"}' : args[0] === 'api' ? '[[]]' : '{}'
      return { code: 0, stdout, stderr: '' }
    }
    const board = new GitHubBoard('acme/app', run, { baseBranch: 'develop' })
    await board.openPullRequest('5', 'Task', 'body', undefined, true)
    const creates = calls.filter((args) => args[1] === 'create')
    expect(creates.map((args) => [args[args.indexOf('--title') + 1], args.includes('--draft')])).toEqual([
      ['Task', true],
      ['Draft: Task', false],
    ])
    await board.readyPullRequest('5', 'Task', 'all parts')
    expect(calls).toContainEqual(['pr', 'ready', '4', '-R', 'acme/app'])
    expect(calls).toContainEqual(['pr', 'edit', '4', '-R', 'acme/app', '--title', 'Task', '--body', 'all parts'])
  })

  it('opens a draft merge request on GitLab with the Draft title and marks it ready with the plain title', async () => {
    const request = { iid: 8, web_url: 'https://example.test/mr/8', sha: 'b'.repeat(40), state: 'opened', draft: true, source_project_id: 1, target_project_id: 1 }
    let created = false
    const { run, calls } = recorder((args) =>
      args.includes('POST') ? ((created = true), '{}') : args.some((arg) => arg.startsWith('users?')) ? '[{"id":7}]' : args.includes('user') ? '{"username":"me"}' : args.some((arg) => arg.includes('/merge_requests?')) ? JSON.stringify(created ? [request] : []) : '[]',
    )
    const board = new GitLabBoard('acme/app', run, { baseBranch: 'develop', retryDelay: 0 })
    await board.openPullRequest('5', 'Task', 'body', undefined, true).catch(() => undefined)
    expect(calls.flat()).toContain('title=Draft: Task')
    board.pullRequest = async () => ({ number: '8', url: request.web_url, headSha: request.sha, state: 'open', checks: 'none', mergeable: 'yes', draft: true, feedback: [], reviews: [], comments: [] })
    await board.readyPullRequest('5', 'Task', 'all parts')
    const put = calls.find((args) => args.includes('PUT')) ?? []
    expect(put).toEqual(expect.arrayContaining([`projects/${encodeURIComponent('acme/app')}/merge_requests/8`, 'title=Task', 'description=all parts']))
  })
})

describe('ignored checks', () => {
  it('leaves listed check runs and statuses out of the result on GitHub', async () => {
    const { run } = recorder((args) =>
      args.some((arg) => arg.includes('/check-runs'))
        ? JSON.stringify([{ check_runs: [{ name: 'deploy (prod)', status: 'completed', conclusion: 'failure' }, { name: 'test', status: 'completed', conclusion: 'success' }] }])
        : JSON.stringify({ statuses: [{ context: 'Deploy/preview', state: 'error' }] }),
    )
    const board = new GitHubBoard('acme/app', run, { ignoreChecks: ['deploy*'] })
    expect(await board.commitChecks('abc')).toBe('success')
    expect(await board.failedChecks('abc')).toEqual([])
    expect(await new GitHubBoard('acme/app', run).commitChecks('abc')).toBe('failure')
  })

  it('judges a GitLab pipeline by its other jobs, bridges, and blocking manual jobs when a listed job fails', async () => {
    const jobs: { name: string; status: string; allow_failure?: boolean }[] = [
      { name: 'unit-test-job', status: 'success' },
      { name: 'deploy:catalog', status: 'failed' },
      { name: 'lint', status: 'failed', allow_failure: true },
    ]
    const bridges: { name: string; status: string; allow_failure?: boolean }[] = []
    const { run, calls } = recorder((args) =>
      args.some((arg) => arg.includes('/jobs')) ? JSON.stringify(jobs) : args.some((arg) => arg.includes('/bridges')) ? JSON.stringify(bridges) : JSON.stringify({ last_pipeline: { id: 5, status: 'failed' } }),
    )
    const board = new GitLabBoard('acme/app', run, { retryDelay: 0, ignoreChecks: ['deploy*'] })
    expect(await board.commitChecks('abc')).toBe('success')
    expect(await board.failedChecks('abc')).toEqual([])
    expect(calls).toContainEqual(['api', `projects/${encodeURIComponent('acme/app')}/pipelines/5/jobs?per_page=100&page=1`])
    bridges.push({ name: 'trigger:downstream', status: 'failed' })
    expect(await board.commitChecks('abc')).toBe('failure')
    expect(await board.failedChecks('abc')).toEqual(['trigger:downstream'])
    bridges.pop()
    jobs.push({ name: 'approve:release', status: 'manual', allow_failure: false })
    expect(await board.commitChecks('abc')).toBe('pending')
    jobs.pop()
    jobs.push({ name: 'integration-test-job', status: 'failed' })
    expect(await board.commitChecks('abc')).toBe('failure')
    expect(await new GitLabBoard('acme/app', run, { retryDelay: 0 }).commitChecks('abc')).toBe('failure')
  })
})

describe('open blockers', () => {
  it('lists the open blockers of a GitHub issue', async () => {
    const { run } = recorder(() => JSON.stringify([[{ number: 279, state: 'open' }, { number: 255, state: 'closed' }], [{ number: 281, state: 'open' }]]))
    expect(await new GitHubBoard('acme/app', run).blockers('285')).toEqual(['279', '281'])
  })

  it('lists the open blockers of a GitLab issue from links and the Blocked by line', async () => {
    const { run } = recorder((args) => {
      const path = args.find((arg) => arg.startsWith('projects/')) ?? ''
      if (path.endsWith('/links')) return JSON.stringify([
        { state: 'opened', link_type: 'is_blocked_by', references: { full: 'acme/app#5' } },
        { state: 'closed', link_type: 'is_blocked_by', references: { full: 'acme/app#6' } },
        { state: 'opened', link_type: 'blocks', references: { full: 'acme/app#8' } },
      ])
      if (path.endsWith('/issues/9')) return JSON.stringify({ description: 'Story\n\nBlocked by: #7, #4', references: { full: 'acme/app#9' } })
      return JSON.stringify({ state: path.endsWith('/issues/7') ? 'opened' : 'closed' })
    })
    expect(await new GitLabBoard('acme/app', run, { retryDelay: 0 }).blockers('9')).toEqual(['5', '7'])
  })
})

describe('cancelled runs', () => {
  it('tells a cancelled GitHub run from a failed one', async () => {
    const runs = [{ name: 'test', status: 'completed', conclusion: 'cancelled' }, { name: 'lint', status: 'completed', conclusion: 'success' }]
    const { run } = recorder((args) => (args.some((arg) => arg.includes('/check-runs')) ? JSON.stringify([{ check_runs: runs }]) : JSON.stringify({ statuses: [] })))
    const board = new GitHubBoard('acme/app', run)
    expect(await board.commitChecks('abc')).toBe('cancelled')
    runs.push({ name: 'build', status: 'completed', conclusion: 'failure' })
    expect(await board.commitChecks('abc')).toBe('failure')
  })

  it('tells a cancelled GitLab pipeline from one with a failed job', async () => {
    const jobs: { name: string; status: string; allow_failure?: boolean }[] = [
      { name: 'unit-test-job', status: 'canceled' },
      { name: 'lint', status: 'failed', allow_failure: true },
    ]
    const { run } = recorder((args) =>
      args.some((arg) => arg.includes('/jobs')) ? JSON.stringify(jobs) : args.some((arg) => arg.includes('/bridges')) ? '[]' : JSON.stringify({ last_pipeline: { id: 5, status: 'canceled' } }),
    )
    const board = new GitLabBoard('acme/app', run, { retryDelay: 0 })
    expect(await board.commitChecks('abc')).toBe('cancelled')
    jobs.push({ name: 'build', status: 'failed' })
    expect(await board.commitChecks('abc')).toBe('failure')
  })
})

describe('passed checks', () => {
  it('lists passed jobs without the ignored ones on GitLab and GitHub', async () => {
    const lab = recorder((args) =>
      args.some((arg) => arg.includes('/jobs'))
        ? JSON.stringify([{ name: 'unit-test-job', status: 'success' }, { name: 'deploy:x', status: 'success' }, { name: 'e2e', status: 'failed' }])
        : args.some((arg) => arg.includes('/bridges'))
          ? JSON.stringify([{ name: 'trigger:docs', status: 'success' }])
          : JSON.stringify({ last_pipeline: { id: 5 } }),
    )
    expect(await new GitLabBoard('acme/app', lab.run, { retryDelay: 0, ignoreChecks: ['deploy*'] }).passedChecks('abc')).toEqual(['unit-test-job', 'trigger:docs'])
    const hub = recorder((args) =>
      args.some((arg) => arg.includes('/check-runs'))
        ? JSON.stringify([{ check_runs: [{ name: 'test', conclusion: 'success' }, { name: 'e2e', conclusion: 'failure' }] }])
        : JSON.stringify({ statuses: [{ context: 'ci/lint', state: 'success' }] }),
    )
    expect(await new GitHubBoard('acme/app', hub.run).passedChecks('abc')).toEqual(['test', 'ci/lint'])
  })
})

describe('head time', () => {
  it('gives no head time on GitHub, where only the commit date is known and a push can come later', async () => {
    const pull = { number: 4, url: 'https://example.test/pull/4', headRefOid: 'a'.repeat(40), state: 'OPEN', mergeable: 'MERGEABLE', isCrossRepository: false, statusCheckRollup: [], reviews: [], comments: [], commits: [{ committedDate: '2026-10-19T07:30:00Z' }] }
    const { run, calls } = recorder((args) => (args[0] === 'pr' ? JSON.stringify([pull]) : '[[]]'))
    expect((await new GitHubBoard('acme/app', run).pullRequest('5'))?.headAt).toBeUndefined()
    expect(calls.find((args) => args[1] === 'list')?.join(' ')).not.toContain('commits')
  })
})

describe('pull requests from forks', () => {
  it('ignores a fork pull request with the task branch name on GitHub', async () => {
    const pull = (number: number, cross: boolean) => ({ number, url: `https://example.test/pull/${number}`, headRefOid: 'a'.repeat(40), state: 'OPEN', mergeable: 'MERGEABLE', isCrossRepository: cross, statusCheckRollup: [], reviews: [], comments: [] })
    const { run } = recorder((args) => (args[0] === 'pr' ? JSON.stringify([pull(9, true), pull(4, false)]) : '[[]]'))
    expect((await new GitHubBoard('acme/app', run).pullRequest('5'))?.number).toBe('4')
    const forkOnly = recorder((args) => (args[0] === 'pr' ? JSON.stringify([pull(9, true)]) : '[[]]'))
    expect(await new GitHubBoard('acme/app', forkOnly.run).pullRequest('5')).toBeUndefined()
  })

  it('ignores a fork merge request with the task branch name on GitLab', async () => {
    const { run, calls } = recorder((args) => (args[1]?.includes('merge_requests?source_branch') ? JSON.stringify([{ iid: 9, source_project_id: 2, target_project_id: 1 }]) : '[]'))
    expect(await new GitLabBoard('acme/app', run, { retryDelay: 0 }).pullRequest('5')).toBeUndefined()
    expect(calls.some((args) => args.some((arg) => arg.includes('merge_requests/9')))).toBe(false)
  })
})
