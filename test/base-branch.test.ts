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
    const { run, calls } = recorder(() => '[]')
    await new GitLabBoard('acme/app', run, { baseBranch: 'develop', retryDelay: 0 }).openPullRequest('5', 'Task', 'body').catch(() => undefined)
    expect(calls.flat()).toContain('target_branch=develop')
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
