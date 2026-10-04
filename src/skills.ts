import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ResolvedSkill =
  | { name: string; source: 'project' | 'personal'; dir: string }
  | { name: string; source: 'plugin'; plugin: string; skill: string; dir: string }

type InstalledPlugins = { plugins?: Record<string, { installPath: string }[]> }

const hasSkill = (dir: string) => existsSync(join(dir, 'SKILL.md'))

export function resolveSkills(names: string[], context: { repo: string; home: string }): { skills: ResolvedSkill[]; missing: string[] } {
  const skills: ResolvedSkill[] = []
  const missing: string[] = []
  for (const name of names) {
    const skill = resolve(name, context)
    if (skill) skills.push(skill)
    else missing.push(name)
  }
  return { skills, missing }
}

function resolve(name: string, context: { repo: string; home: string }): ResolvedSkill | undefined {
  const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [undefined, name]
  if (!plugin || !skill) {
    const project = join(context.repo, '.claude', 'skills', name)
    if (hasSkill(project)) return { name, source: 'project', dir: project }
    const personal = join(context.home, '.claude', 'skills', name)
    if (hasSkill(personal)) return { name, source: 'personal', dir: personal }
    return undefined
  }
  for (const installPath of pluginPaths(plugin, context.home)) {
    const dir = join(installPath, 'skills', skill)
    if (hasSkill(dir)) return { name, source: 'plugin', plugin, skill, dir }
  }
  return undefined
}

function pluginPaths(plugin: string, home: string): string[] {
  const file = join(home, '.claude', 'plugins', 'installed_plugins.json')
  if (!existsSync(file)) return []
  const installed = JSON.parse(readFileSync(file, 'utf8')) as InstalledPlugins
  return Object.entries(installed.plugins ?? {})
    .filter(([key]) => key.split('@')[0] === plugin)
    .flatMap(([, installs]) => installs.map((install) => install.installPath))
}
