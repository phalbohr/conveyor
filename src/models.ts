import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Run } from './cli.js'
import type { Config } from './config.js'

export type ModelInfo = { id: string; efforts?: string[] }
export type Catalog = { models: ModelInfo[]; efforts?: string[]; fetchedAt: string; error?: string }

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1']
const MODEL_ERROR = /unrecognized_model|model is not supported|model\b[^\n]{0,60}\bnot (?:found|supported|available)|ModelNotFound|unknown model/i

type CodexCatalog = { models?: { slug?: string; visibility?: string; supported_reasoning_levels?: ({ effort?: string } | string)[] }[] }

export async function discoverModels(harness: string, config: Config, run: Run): Promise<Catalog> {
  const fetchedAt = new Date().toISOString()
  const definition = config.harnesses[harness]
  if (harness === 'claude') return { models: CLAUDE_MODELS.map((id) => ({ id })), efforts: CLAUDE_EFFORTS, fetchedAt }

  const base = { fetchedAt, ...(definition?.efforts ? { efforts: definition.efforts } : {}) }
  const command = harness === 'codex' ? { command: 'codex', args: ['debug', 'models'] } : definition?.models ? { command: definition.models.command ?? definition.command, args: definition.models.args } : undefined
  if (!command) return { models: [], ...base }

  const result = await run(command.command, command.args)
  if (result.code !== 0) return { models: [], ...base, error: (result.stderr || result.stdout).trim().slice(0, 300) || `${command.command} exited with code ${result.code}` }
  if (harness === 'codex') {
    try {
      const catalog = JSON.parse(result.stdout) as CodexCatalog
      const models = (catalog.models ?? [])
        .filter((model) => model.slug && model.visibility !== 'hide')
        .map((model) => ({
          id: model.slug as string,
          efforts: (model.supported_reasoning_levels ?? []).map((level) => (typeof level === 'string' ? level : (level.effort ?? ''))).filter(Boolean),
        }))
      return { models, ...base }
    } catch {
      return { models: [], ...base, error: 'codex debug models returned no JSON' }
    }
  }
  const models = result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((id) => /^[\w.:/@-]+$/.test(id) && !/^(provider|model|models|name|id)$/i.test(id))
  return { models: [...new Set(models)].map((id) => ({ id })), ...base }
}

export function modelKnown(catalog: Catalog | undefined, model: string) {
  if (!catalog || catalog.models.length === 0) return true
  return catalog.models.some((entry) => entry.id === model)
}

export function effortsFor(catalog: Catalog | undefined, model: string): string[] | undefined {
  if (!catalog) return undefined
  const efforts = catalog.models.find((entry) => entry.id === model)?.efforts
  return efforts?.length ? efforts : catalog.efforts
}

export function isModelError(text: string) {
  return MODEL_ERROR.test(text)
}

export class ModelCache {
  private readonly catalogs: Record<string, Catalog>

  constructor(private readonly file?: string) {
    this.catalogs = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Catalog>) : {}
  }

  get(harness: string): Catalog | undefined {
    return this.catalogs[harness]
  }

  set(harness: string, catalog: Catalog) {
    this.catalogs[harness] = catalog
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.catalogs))
  }
}

export async function catalogsFor(harnesses: string[], config: Config, run: Run, cache: ModelCache, refresh: boolean) {
  const catalogs: Record<string, Catalog> = {}
  for (const harness of harnesses) {
    const cached = cache.get(harness)
    const catalog = !refresh && cached ? cached : await discoverModels(harness, config, run)
    if (!cached || refresh) cache.set(harness, catalog)
    catalogs[harness] = catalog
  }
  return catalogs
}
