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
