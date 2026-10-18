import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Run } from './cli.js'
import type { Repos } from './config.js'
import { expandPath } from './paths.js'
import { createRun } from './run.js'

export type GroupProject = { name: string; path: string; sshUrl: string; defaultBranch: string }
export type RepoClone = { name: string; path: string; base: string }

export async function groupProjects(run: Run, group: string): Promise<GroupProject[]> {
  const projects: GroupProject[] = []
  for (let page = 1; ; page++) {
    const result = await run('glab', ['api', `groups/${encodeURIComponent(group)}/projects?include_subgroups=true&archived=false&per_page=100&page=${page}`])
    if (result.code !== 0) throw new Error(`glab api groups/${group}/projects failed: ${(result.stderr || result.stdout).trim() || 'no answer from glab'}`)
    const batch = JSON.parse(result.stdout) as { path_with_namespace: string; ssh_url_to_repo: string; default_branch: string | null }[]
    for (const project of batch) {
      if (!project.default_branch) continue
      projects.push({ name: project.path_with_namespace.slice(group.length + 1), path: project.path_with_namespace, sshUrl: project.ssh_url_to_repo, defaultBranch: project.default_branch })
    }
    if (batch.length < 100) return projects.sort((a, b) => a.name.localeCompare(b.name))
  }
}

export async function repoProjects(run: Run, repos: Repos): Promise<GroupProject[]> {
  if (!repos.projects) return groupProjects(run, repos.group ?? '')
  const projects: GroupProject[] = []
  for (const [name, path] of Object.entries(repos.projects)) {
    const result = await run('glab', ['api', `projects/${encodeURIComponent(path)}`])
    if (result.code !== 0) throw new Error(`repos.projects: ${path}: glab api failed: ${(result.stderr || result.stdout).trim() || 'no answer from glab'}`)
    const project = JSON.parse(result.stdout) as { ssh_url_to_repo: string; default_branch: string | null }
    if (!project.default_branch) throw new Error(`repos.projects: ${path} has no commits yet`)
    projects.push({ name, path, sshUrl: project.ssh_url_to_repo, defaultBranch: project.default_branch })
  }
  return projects
}

export async function repoClones(options: { repos: Repos; projects: GroupProject[]; paths: Record<string, string>; home: string; cwd: string }): Promise<RepoClone[]> {
  const { repos, projects, paths, home, cwd } = options
  const known = new Set(projects.map((project) => project.name))
  const missing = (repos.include ?? []).filter((name) => !known.has(name))
  if (missing.length > 0) throw new Error(`repos.include: no project ${missing.join(', ')} in the group ${repos.group}`)
  const chosen = projects.filter((project) => !repos.exclude.includes(project.name) && (!repos.include || repos.include.includes(project.name)))
  const clones: RepoClone[] = []
  for (const project of chosen) {
    const own = paths[project.name]
    const path = own
      ? resolve(cwd, expandPath(own, { home, project: project.name }))
      : join(home, '.conveyor', 'repos', ...project.path.split('/'))
    if (!existsSync(path)) {
      if (own) throw new Error(`repo_paths.${project.name}: ${path} does not exist`)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const cloned = await createRun(dirname(path))('git', ['clone', '--quiet', project.sshUrl, path])
      if (cloned.code !== 0) throw new Error(`git clone ${project.sshUrl} failed: ${cloned.stderr.trim()}`)
    }
    const origin = await createRun(path)('git', ['remote', 'get-url', 'origin'])
    if (origin.code !== 0 || !sameRepository(origin.stdout.trim(), project.sshUrl)) {
      throw new Error(`${own ? `repo_paths.${project.name}` : 'the clone'} ${path} is not a clone of ${project.path} (origin ${origin.stdout.trim() || 'missing'})`)
    }
    clones.push({ name: project.name, path, base: repos.base[project.name] ?? project.defaultBranch })
  }
  return clones
}

function sameRepository(a: string, b: string) {
  const key = (url: string) => url.replace(/\.git$/, '').replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '').replace(/^[^@/]+@/, '').replace(':', '/').toLowerCase()
  return key(a) === key(b)
}
