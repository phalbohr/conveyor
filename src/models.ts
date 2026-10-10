import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Run } from './cli.js'
import type { Config } from './config.js'
import { childEnv } from './harness/harness.js'

export type ModelInfo = { id: string; label?: string; aliases?: string[]; efforts?: string[] }
export type Catalog = { models: ModelInfo[]; efforts?: string[]; fetchedAt: string; error?: string }
export type ClaudeModel = { value: string; resolvedModel?: string; displayName?: string; supportedEffortLevels?: string[] }
export type Probes = { run: Run; claudeModels?: () => Promise<ClaudeModel[]> }

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODEL_ERROR = /unrecognized_model|model is not supported|model\b[^\n]{0,60}\bnot (?:found|supported|available)|ModelNotFound|unknown model/i

type CodexCatalog = { models?: { slug?: string; visibility?: string; supported_reasoning_levels?: ({ effort?: string } | string)[] }[] }

export async function discoverModels(harness: string, config: Config, probes: Probes): Promise<Catalog> {
  const { run } = probes
  const fetchedAt = new Date().toISOString()
  const definition = config.harnesses[harness]
  if (harness === 'claude') {
    try {
      return { models: claudeCatalog(await (probes.claudeModels ?? claudeModels)()), efforts: CLAUDE_EFFORTS, fetchedAt }
    } catch (error) {
      return { models: [], efforts: CLAUDE_EFFORTS, fetchedAt, error: (error as Error).message }
    }
  }

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
  return catalog.models.some((entry) => entry.id === model || entry.aliases?.includes(model))
}

export function effortsFor(catalog: Catalog | undefined, model: string): string[] | undefined {
  if (!catalog) return undefined
  const efforts = catalog.models.find((entry) => entry.id === model || entry.aliases?.includes(model))?.efforts
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

export async function catalogsFor(harnesses: string[], config: Config, probes: Probes, cache: ModelCache, refresh: boolean) {
  const catalogs: Record<string, Catalog> = {}
  for (const harness of harnesses) {
    const cached = cache.get(harness)
    const usable = !refresh && cached && !cached.error ? cached : undefined
    const catalog = usable ?? (await discoverModels(harness, config, probes))
    if (!usable) cache.set(harness, catalog)
    catalogs[harness] = catalog
  }
  return catalogs
}

function claudeCatalog(models: ClaudeModel[]): ModelInfo[] {
  const catalog = new Map<string, ModelInfo>()
  for (const model of models) {
    const id = model.resolvedModel ?? model.value
    const entry = catalog.get(id) ?? { id, ...(model.displayName && model.value !== 'default' ? { label: model.displayName } : {}), aliases: [] }
    if (model.value !== id) entry.aliases = [...(entry.aliases ?? []), model.value]
    if (model.supportedEffortLevels?.length) entry.efforts = model.supportedEffortLevels
    if (!entry.label && model.displayName && model.value !== 'default') entry.label = model.displayName
    catalog.set(id, entry)
  }
  return [...catalog.values()].map((entry) => (entry.aliases?.length ? entry : (({ aliases: _aliases, ...rest }) => rest)(entry)))
}

export function claudeModels(timeoutMs = 30_000): Promise<ClaudeModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local', '--strict-mcp-config', '--no-session-persistence'],
      { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv(process.env) },
    )
    const timer = setTimeout(() => finish(new Error('claude did not answer the model query')), timeoutMs)
    let buffer = ''
    let done = false
    const finish = (error?: Error, models?: ClaudeModel[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(models ?? [])
    }
    child.on('error', (error) => finish(error))
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      for (const line of buffer.split('\n').slice(0, -1)) {
        try {
          const event = JSON.parse(line) as { type?: string; response?: { request_id?: string; response?: { models?: ClaudeModel[] } } }
          if (event.type === 'control_response' && event.response?.request_id === 'conveyor-models') finish(undefined, event.response.response?.models ?? [])
        } catch {
          continue
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1)
    })
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'conveyor-models', request: { subtype: 'initialize' } })}\n`)
  })
}
