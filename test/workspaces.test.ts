import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitWorkspaces } from '../src/workspaces.js'
import { tempDir } from './helpers.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repository() {
  const origin = join(tempDir('conveyor-origin-'), 'origin.git')
  git(tempDir(), 'init', '--bare', '--initial-branch=main', origin)
  const seed = tempDir('conveyor-seed-')
  git(seed, 'clone', origin, '.')
  git(seed, 'config', 'user.email', 'test@example.com')
  git(seed, 'config', 'user.name', 'Test')
  writeFileSync(join(seed, 'README.md'), 'seed\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'push', 'origin', 'main')
  const project = tempDir('conveyor-project-')
  git(project, 'clone', origin, '.')
  git(project, 'config', 'user.email', 'test@example.com')
  git(project, 'config', 'user.name', 'Test')
  return { origin, project, seed }
}

function workspaces(project: string, hooks: Partial<ReturnType<ConstructorParameters<typeof GitWorkspaces>[0]['hooks']>> = {}) {
  return new GitWorkspaces({ repo: project, root: join(tempDir('conveyor-ws-'), 'workspaces'), base: async () => 'main', hooks: () => ({ timeout: 5_000, ...hooks }) })
}

describe('GitWorkspaces', () => {
  it('creates one worktree per task on the task branch', async () => {
    const { project } = repository()
    const manager = workspaces(project)

    const first = await manager.prepare('7')
    expect(first.created).toBe(true)
    expect(git(first.path, 'branch', '--show-current')).toBe('conveyor/7')
    expect(readFileSync(join(first.path, 'README.md'), 'utf8')).toBe('seed\n')

    const again = await manager.prepare('7')
    expect(again).toEqual({ path: first.path, created: false })
    expect(await manager.list()).toEqual(['7'])
  })

  it('continues the remote task branch', async () => {
    const { project, seed } = repository()
    git(seed, 'switch', '-c', 'conveyor/9')
    writeFileSync(join(seed, 'work.txt'), 'previous owner\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-m', 'work')
    git(seed, 'push', 'origin', 'conveyor/9')

    const workspace = await workspaces(project).prepare('9')
    expect(readFileSync(join(workspace.path, 'work.txt'), 'utf8')).toBe('previous owner\n')
  })

  it('starts and resets task branches from the base branch', async () => {
    const { project, seed } = repository()
    git(seed, 'switch', '-c', 'develop')
    writeFileSync(join(seed, 'develop.txt'), 'develop\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-m', 'develop')
    git(seed, 'push', 'origin', 'develop')
    const manager = new GitWorkspaces({ repo: project, root: join(tempDir(), 'ws'), base: async () => 'develop', hooks: () => ({ timeout: 5_000 }) })

    const workspace = await manager.prepare('8')
    expect(existsSync(join(workspace.path, 'develop.txt'))).toBe(true)
    writeFileSync(join(workspace.path, 'work.txt'), 'work\n')
    await manager.commitAll('8', 'work')
    await manager.reset('8')
    expect(existsSync(join(workspace.path, 'work.txt'))).toBe(false)
    expect(existsSync(join(workspace.path, 'develop.txt'))).toBe(true)
  })

  it('runs after_create once in a new workspace', async () => {
    const { project } = repository()
    const manager = workspaces(project, { after_create: 'echo created >> hook.log' })
    const { path } = await manager.prepare('1')
    await manager.prepare('1')
    expect(readFileSync(join(path, 'hook.log'), 'utf8')).toBe('created\n')
  })

  it('removes the workspace when after_create fails', async () => {
    const { project } = repository()
    const manager = workspaces(project, { after_create: 'exit 3' })
    await expect(manager.prepare('1')).rejects.toThrow('after_create')
    expect(await manager.list()).toEqual([])
  })

  it('fails on before_run errors and ignores after_run errors', async () => {
    const { project } = repository()
    const failing = workspaces(project, { before_run: 'exit 1', after_run: 'exit 1' })
    const { path } = await failing.prepare('1')
    await expect(failing.runHook('before_run', path)).rejects.toThrow('before_run')
    await expect(failing.runHook('after_run', path)).resolves.toBeUndefined()
  })

  it('uses the current hooks on every call', async () => {
    const { project } = repository()
    let script = 'echo first >> hook.log'
    const manager = new GitWorkspaces({ repo: project, root: join(tempDir(), 'ws'), base: async () => 'main', hooks: () => ({ timeout: 5_000, before_run: script }) })
    const { path } = await manager.prepare('1')
    await manager.runHook('before_run', path)
    script = 'echo second >> hook.log'
    await manager.runHook('before_run', path)
    expect(readFileSync(join(path, 'hook.log'), 'utf8')).toBe('first\nsecond\n')
  })

  it('stops a hook after the timeout', async () => {
    const { project } = repository()
    const manager = workspaces(project, { before_run: 'sleep 30', timeout: 200 })
    const { path } = await manager.prepare('1')
    const started = Date.now()
    await expect(manager.runHook('before_run', path)).rejects.toThrow('timed out')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('commits a file and pushes the task branch', async () => {
    const { project, origin } = repository()
    const manager = workspaces(project)
    const { path } = await manager.prepare('4')
    await manager.commitFile('4', 'docs/plans/4-plan.md', '# Plan\n', 'Add plan for task 4')
    await manager.push('4')
    expect(git(origin, 'show', 'conveyor/4:docs/plans/4-plan.md')).toBe('# Plan')
    expect(existsSync(join(path, 'docs/plans/4-plan.md'))).toBe(true)
  })

  it('refuses to write an artifact through a symbolic link or outside the workspace', async () => {
    const { project } = repository()
    const manager = workspaces(project)
    const { path } = await manager.prepare('5')
    const outside = tempDir('conveyor-outside-')
    symlinkSync(outside, join(path, 'docs'))
    await expect(manager.commitFile('5', 'docs/5-plan.md', 'x', 'Add plan')).rejects.toThrow('symbolic link')
    await expect(manager.commitFile('5', '../5-plan.md', 'x', 'Add plan')).rejects.toThrow('outside the workspace')
    expect(readdirSync(outside)).toEqual([])
  })

  it('commits all stage changes and skips a clean workspace', async () => {
    const { project, origin } = repository()
    const manager = workspaces(project)
    const { path } = await manager.prepare('6')
    writeFileSync(join(path, 'feature.txt'), 'new\n')
    writeFileSync(join(path, 'README.md'), 'changed\n')

    expect(await manager.commitAll('6', 'implement: add feature')).toBe(true)
    expect(await manager.commitAll('6', 'review: nothing')).toBe(false)
    await manager.push('6')

    expect(git(origin, 'log', '-1', '--format=%s', 'conveyor/6')).toBe('implement: add feature')
    expect(git(origin, 'show', 'conveyor/6:feature.txt')).toBe('new')
  })

  it('resets the task branch to the base branch', async () => {
    const { project, origin } = repository()
    const manager = workspaces(project)
    const { path } = await manager.prepare('8')
    writeFileSync(join(path, 'wrong.txt'), 'wrong approach\n')
    await manager.commitAll('8', 'implement: wrong approach')
    await manager.push('8')
    writeFileSync(join(path, 'untracked.txt'), 'leftover\n')

    await manager.reset('8')

    expect(existsSync(join(path, 'wrong.txt'))).toBe(false)
    expect(existsSync(join(path, 'untracked.txt'))).toBe(false)
    expect(git(origin, 'rev-parse', 'conveyor/8')).toBe(git(origin, 'rev-parse', 'main'))
  })

  it('deletes the remote task branch and ignores a missing one', async () => {
    const { project, origin } = repository()
    const manager = workspaces(project)
    await manager.prepare('11')
    await manager.push('11')
    await manager.deleteBranch('11')
    await manager.deleteBranch('11')
    expect(git(origin, 'branch', '--list', 'conveyor/11')).toBe('')
  })

  it('runs before_remove and removes the workspace', async () => {
    const { project } = repository()
    const marker = join(tempDir(), 'removed')
    const manager = workspaces(project, { before_remove: `touch ${marker}` })
    const { path } = await manager.prepare('5')
    await manager.remove('5')
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(await manager.list()).toEqual([])
  })

  it('removes a missing workspace without error', async () => {
    const { project } = repository()
    await expect(workspaces(project).remove('404')).resolves.toBeUndefined()
  })
})
