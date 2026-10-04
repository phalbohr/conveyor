import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'

export const SETTINGS_DIR = '.conveyor'

function registryPath(home: string) {
  return join(home, '.conveyor', 'projects.yaml')
}

function readRegistry(home: string): Record<string, string> {
  const path = registryPath(home)
  return existsSync(path) ? ((parse(readFileSync(path, 'utf8')) as Record<string, string> | null) ?? {}) : {}
}

export function findSettings(cwd: string, home: string): string | undefined {
  const local = join(cwd, SETTINGS_DIR)
  if (existsSync(join(local, 'config.yaml'))) return local
  return readRegistry(home)[cwd]
}

export function linkSettings(cwd: string, home: string, settings: string) {
  const registry = readRegistry(home)
  registry[cwd] = settings
  mkdirSync(dirname(registryPath(home)), { recursive: true })
  writeFileSync(registryPath(home), stringify(registry))
}
