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
