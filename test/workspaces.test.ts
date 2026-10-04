import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

function workspaces(project: string, hooks: Partial<ConstructorParameters<typeof GitWorkspaces>[0]['hooks']> = {}) {
  return new GitWorkspaces({ repo: project, root: join(tempDir('conveyor-ws-'), 'workspaces'), hooks: { timeout: 5_000, ...hooks } })
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
