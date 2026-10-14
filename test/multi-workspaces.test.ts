import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MultiWorkspaces } from '../src/multi-workspaces.js'
import { repoClones, type GroupProject } from '../src/repos.js'
import { tempDir } from './helpers.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function origin(name: string, branch: string) {
  const bare = join(tempDir(`conveyor-${name}-`), `${name}.git`)
  git(tempDir(), 'init', '--bare', `--initial-branch=${branch}`, bare)
  const seed = tempDir('conveyor-seed-')
  git(seed, 'clone', bare, '.')
  writeFileSync(join(seed, 'README.md'), `${name}\n`)
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'push', 'origin', branch)
  return bare
}

function group() {
  const projects: GroupProject[] = [
    { name: 'frontend', sshUrl: origin('frontend', 'develop'), defaultBranch: 'develop' },
    { name: 'user-service', sshUrl: origin('user-service', 'develop'), defaultBranch: 'develop' },
    { name: 'docs', sshUrl: origin('docs', 'main'), defaultBranch: 'main' },
  ]
  return { projects, home: tempDir('conveyor-home-'), cwd: tempDir('conveyor-settings-repo-') }
}

describe('repoClones', () => {
  it('clones the chosen projects of the group once and uses existing clones from repo_paths', async () => {
    const { projects, home, cwd } = group()
    const own = join(cwd, 'umbrella', 'frontend')
    git(cwd, 'clone', '--quiet', projects[0]?.sshUrl ?? '', own)
    const repos = { group: 'shop', exclude: ['docs'], base: { 'user-service': 'main' } }
    const clones = await repoClones({ repos, projects, paths: { frontend: 'umbrella/frontend' }, home, cwd })
    expect(clones).toEqual([
      { name: 'frontend', path: own, base: 'develop' },
      { name: 'user-service', path: join(home, '.conveyor', 'repos', 'shop', 'user-service'), base: 'main' },
    ])
    expect(existsSync(join(home, '.conveyor', 'repos', 'shop', 'user-service', 'README.md'))).toBe(true)
    expect(await repoClones({ repos, projects, paths: { frontend: 'umbrella/frontend' }, home, cwd })).toEqual(clones)
  })

  it('names unknown repositories and clones of another repository', async () => {
    const { projects, home, cwd } = group()
    await expect(repoClones({ repos: { group: 'shop', include: ['payment'], exclude: [], base: {} }, projects, paths: {}, home, cwd })).rejects.toThrow('repos.include: no project payment in the group shop')
    const wrong = join(cwd, 'wrong')
    git(cwd, 'clone', '--quiet', projects[2]?.sshUrl ?? '', wrong)
    await expect(repoClones({ repos: { group: 'shop', include: ['frontend'], exclude: [], base: {} }, projects, paths: { frontend: 'wrong' }, home, cwd })).rejects.toThrow('repo_paths.frontend')
  })
})

describe('MultiWorkspaces', () => {
  async function setup(hooks: Record<string, string> = {}) {
    const { projects, home, cwd } = group()
    const clones = await repoClones({ repos: { group: 'shop', exclude: ['docs'], base: {} }, projects, paths: {}, home, cwd })
    const root = join(tempDir('conveyor-ws-'), 'workspaces')
    return { clones, root, workspaces: new MultiWorkspaces({ root, clones: async () => clones, hooks: () => ({ timeout: 5_000, ...hooks }) }) }
  }

  it('puts one worktree per repository side by side in the folder of the task', async () => {
    const { workspaces, root } = await setup({ after_create: "printf '%s\\n' */ > created.txt" })
    const prepared = await workspaces.prepare('frontend#12')
    expect(prepared).toEqual({ path: join(root, 'frontend-12'), created: true })
    expect(git(join(prepared.path, 'frontend'), 'branch', '--show-current')).toBe('conveyor/frontend-12')
    expect(readFileSync(join(prepared.path, 'user-service', 'README.md'), 'utf8')).toBe('user-service\n')
    expect(readFileSync(join(prepared.path, 'created.txt'), 'utf8').trim().split('\n')).toEqual(['frontend/', 'user-service/'])
    expect(await workspaces.prepare('frontend#12')).toEqual({ path: prepared.path, created: false })
    expect(await workspaces.list()).toEqual(['frontend#12'])
  })

  it('commits and pushes only the repositories the task changed', async () => {
    const { workspaces, clones } = await setup()
    const { path } = await workspaces.prepare('frontend#12')
    writeFileSync(join(path, 'user-service', 'api.txt'), 'endpoint\n')
    expect(await workspaces.commitAll('frontend#12', 'implement: endpoint')).toBe(true)
    expect(await workspaces.changed('frontend#12')).toEqual(['user-service'])
    expect(await workspaces.ahead('frontend#12')).toBe(1)
    expect(await workspaces.push('frontend#12')).toMatch(/^user-service@[0-9a-f]{40}$/)
    const remote = (name: string) => git(clones.find((clone) => clone.name === name)?.path ?? '', 'ls-remote', '--heads', 'origin', 'conveyor/frontend-12')
    expect(remote('user-service')).toContain('conveyor/frontend-12')
    expect(remote('frontend')).toBe('')
    await workspaces.commitFile('frontend#12', 'frontend/docs/plan.md', 'plan\n', 'plan')
    expect(await workspaces.changed('frontend#12')).toEqual(['frontend', 'user-service'])
    await expect(workspaces.commitFile('frontend#12', 'docs/plan.md', 'plan\n', 'plan')).rejects.toThrow('starts with the name of one of the repositories')
  })

  it('removes every worktree and the folder of the task', async () => {
    const { workspaces, root, clones } = await setup()
    await workspaces.prepare('frontend#12')
    await workspaces.remove('frontend#12')
    expect(existsSync(join(root, 'frontend-12'))).toBe(false)
    expect(await workspaces.list()).toEqual([])
    for (const clone of clones) expect(git(clone.path, 'worktree', 'list')).not.toContain('frontend-12')
  })
})
