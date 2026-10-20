import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MultiWorkspaces } from '../src/multi-workspaces.js'
import { repoClones, repoProjects, type GroupProject } from '../src/repos.js'
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
    { name: 'frontend', path: 'shop/frontend', sshUrl: origin('frontend', 'develop'), defaultBranch: 'develop' },
    { name: 'user-service', path: 'shop/user-service', sshUrl: origin('user-service', 'develop'), defaultBranch: 'develop' },
    { name: 'docs', path: 'shop/docs', sshUrl: origin('docs', 'main'), defaultBranch: 'main' },
  ]
  return { projects, home: tempDir('conveyor-home-'), cwd: tempDir('conveyor-settings-repo-') }
}

describe('repoClones', () => {
  it('clones the chosen projects of the group once and uses existing clones from repo_paths', async () => {
    const { projects, home, cwd } = group()
    const own = join(cwd, 'parent', 'frontend')
    git(cwd, 'clone', '--quiet', projects[0]?.sshUrl ?? '', own)
    const repos = { group: 'shop', exclude: ['docs'], base: { 'user-service': 'main' } }
    const clones = await repoClones({ repos, projects, paths: { frontend: 'parent/frontend' }, home, cwd })
    expect(clones).toEqual([
      { name: 'frontend', path: own, base: 'develop' },
      { name: 'user-service', path: join(home, '.conveyor', 'repos', 'shop', 'user-service'), base: 'main' },
    ])
    expect(existsSync(join(home, '.conveyor', 'repos', 'shop', 'user-service', 'README.md'))).toBe(true)
    expect(await repoClones({ repos, projects, paths: { frontend: 'parent/frontend' }, home, cwd })).toEqual(clones)
  })

  it('takes listed projects from several groups and clones each under its full path', async () => {
    const urls: Record<string, string> = { 'shop/frontend': origin('frontend', 'develop'), 'tools/handbook': origin('handbook', 'main') }
    const run = async (_command: string, args: string[]) => {
      const path = decodeURIComponent(args[1]?.replace(/^projects\//, '') ?? '')
      return urls[path] ? { code: 0, stdout: JSON.stringify({ ssh_url_to_repo: urls[path], default_branch: path === 'shop/frontend' ? 'develop' : 'main' }), stderr: '' } : { code: 1, stdout: '', stderr: '404 Project Not Found' }
    }
    const repos = { projects: { frontend: 'shop/frontend', 'handbook': 'tools/handbook' }, exclude: [], base: {} }
    const projects = await repoProjects(run, repos)
    expect(projects.map((project) => [project.name, project.path, project.defaultBranch])).toEqual([
      ['frontend', 'shop/frontend', 'develop'],
      ['handbook', 'tools/handbook', 'main'],
    ])
    const home = tempDir('conveyor-home-')
    const clones = await repoClones({ repos, projects, paths: {}, home, cwd: tempDir() })
    expect(clones.map((clone) => clone.path)).toEqual([join(home, '.conveyor', 'repos', 'shop', 'frontend'), join(home, '.conveyor', 'repos', 'tools', 'handbook')])
    await expect(repoProjects(run, { projects: { gone: 'old/gone' }, exclude: [], base: {} })).rejects.toThrow('repos.projects: old/gone: glab api failed: 404 Project Not Found')
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

  it('removes a task folder left by another setup whose repository folders are no worktrees', async () => {
    const { workspaces, root } = await setup()
    mkdirSync(join(root, 'frontend-12', 'frontend'), { recursive: true })
    writeFileSync(join(root, 'frontend-12', 'frontend', 'README.md'), 'old\n')
    await workspaces.remove('frontend#12')
    expect(existsSync(join(root, 'frontend-12'))).toBe(false)
  })

  it('deletes the pushed task branch in every repository on reset', async () => {
    const { workspaces, clones } = await setup()
    const { path } = await workspaces.prepare('frontend#12')
    writeFileSync(join(path, 'frontend', 'ui.txt'), 'ui\n')
    await workspaces.commitAll('frontend#12', 'implement: ui')
    await workspaces.push('frontend#12')
    const remote = () => git(clones.find((clone) => clone.name === 'frontend')?.path ?? '', 'ls-remote', '--heads', 'origin', 'conveyor/frontend-12')
    expect(remote()).toContain('conveyor/frontend-12')
    await workspaces.remove('frontend#12')
    await workspaces.deleteBranch('frontend#12')
    expect(remote()).toBe('')
    await expect(workspaces.deleteBranch('frontend#12')).resolves.toBeUndefined()
    const again = await workspaces.prepare('frontend#12')
    expect(existsSync(join(again.path, 'frontend', 'ui.txt'))).toBe(false)
  })

  it('says why a task branch could not be deleted', async () => {
    const { workspaces, clones } = await setup()
    await workspaces.prepare('frontend#12')
    git(clones[0]?.path ?? '', 'remote', 'set-url', 'origin', join(tempDir(), 'gone.git'))
    await expect(workspaces.deleteBranch('frontend#12')).rejects.toThrow('git push origin --delete conveyor/frontend-12 failed in')
  })

  it('lists the repositories again after a failed first attempt', async () => {
    const { projects, home, cwd } = group()
    const clones = await repoClones({ repos: { group: 'shop', exclude: ['docs'], base: {} }, projects, paths: {}, home, cwd })
    let calls = 0
    const workspaces = new MultiWorkspaces({
      root: join(tempDir('conveyor-ws-'), 'workspaces'),
      clones: async () => {
        calls++
        if (calls === 1) throw new Error('glab api failed (HTTP 502)')
        return clones
      },
      hooks: () => ({ timeout: 5_000 }),
    })
    await expect(workspaces.names()).rejects.toThrow('HTTP 502')
    expect(await workspaces.names()).toEqual(['frontend', 'user-service'])
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
