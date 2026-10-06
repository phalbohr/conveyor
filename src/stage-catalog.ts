import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import { parseStageFile } from './engine/stage-file.js'

export type StageEntry = { name: string; enabled: boolean; reserved: boolean; described: boolean }

const RESERVED = ['story', 'plan', 'merge']

export function stageStub(name: string) {
  return `# Stage: ${name}\n\nDescribe what the ${name} stage does: its goal, the steps, and when it is done.\n`
}

export function stageDescribed(settingsDir: string, name: string): boolean {
  const path = join(settingsDir, 'stages', `${name}.md`)
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  if (text.trim() === stageStub(name).trim()) return false
  const file = parseStageFile(text)
  return !file.ok || file.template.trim().length > 0
}

export function stageCatalog(settingsDir: string, config: Config): StageEntry[] {
  const configured = config.stages.map((stage) => stage.name)
  const dir = join(settingsDir, 'stages')
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith('.md'))
        .map((file) => file.slice(0, -3))
        .filter((name) => !configured.includes(name))
        .sort()
    : []
  return [
    ...configured.map((name) => ({ name, enabled: true, reserved: RESERVED.includes(name), described: stageDescribed(settingsDir, name) })),
    ...files.map((name) => ({ name, enabled: false, reserved: false, described: stageDescribed(settingsDir, name) })),
  ]
}

export function undescribedStages(settingsDir: string, config: Config): string[] {
  return stageCatalog(settingsDir, config)
    .filter((entry) => entry.enabled && !entry.described)
    .map((entry) => entry.name)
}

export function undescribedNotice(names: string[]) {
  return names.map((name) => `Stage ${name} has no description: write it in stages/${name}.md`)
}
