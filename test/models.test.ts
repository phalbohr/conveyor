import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Run } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { CLAUDE_EFFORTS, ModelCache, discoverModels, effortsFor, isModelError, modelKnown } from '../src/models.js'
import { FakeBoard } from '../src/board/fake.js'
import { CLAUDE_MODELS, runCli, tempDir } from './helpers.js'

function config(extra = '') {
  const dir = tempDir()
  writeFileSync(join(dir, 'config.yaml'), `board: {provider: github, project: acme/app}\n${extra}`)
  const loaded = loadConfig(dir)
  if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  return loaded.config
}

const responder =
  (outputs: Record<string, string>): Run =>
  async (command, args) => {
    const key = [command, ...args].join(' ')
    return key in outputs ? { code: 0, stdout: outputs[key] ?? '', stderr: '' } : { code: 127, stdout: '', stderr: `${command}: not found` }
  }

const CODEX_CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-6-luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], visibility: 'list' },
    { slug: 'gpt-6-sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], visibility: 'list' },
    { slug: 'gpt-hidden', supported_reasoning_levels: [], visibility: 'hide' },
  ],
})

describe('discoverModels', () => {
  it('lists the claude models with versions, names, aliases, and efforts', async () => {
    const catalog = await discoverModels('claude', config(), { run: responder({}), claudeModels: async () => CLAUDE_MODELS })
    expect(catalog.models).toEqual([
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', aliases: ['default', 'haiku'] },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', aliases: ['opus'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', aliases: ['sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-opus-5', label: 'Opus 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
    ])
    expect(catalog.efforts).toEqual(CLAUDE_EFFORTS)
    expect(modelKnown(catalog, 'opus')).toBe(true)
    expect(effortsFor(catalog, 'claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('reports when claude does not answer the model query', async () => {
    const catalog = await discoverModels('claude', config(), {
      run: responder({}),
      claudeModels: async () => Promise.reject(new Error('claude did not answer the model query')),
    })
    expect(catalog).toMatchObject({ models: [], error: 'claude did not answer the model query' })
  })

  it('reads the codex catalog with efforts per model', async () => {
    const catalog = await discoverModels('codex', config(), { run: responder({ 'codex debug models': CODEX_CATALOG }), claudeModels: async () => CLAUDE_MODELS })
    expect(catalog.models).toEqual([
      { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] },
      { id: 'gpt-6-sol', efforts: ['low', 'ultra'] },
    ])
  })

  it('runs the models command of a harness and reads one model per line', async () => {
    const catalog = await discoverModels(
      'opencode',
      config(),
      { run: responder({ 'opencode models': 'anthropic/claude-opus-5-5\nlitellm/qwen3-coder\n\nlocal/llama-4  (self-hosted)\n' }) },
    )
    expect(catalog.models.map((model) => model.id)).toEqual(['anthropic/claude-opus-5-5', 'litellm/qwen3-coder', 'local/llama-4'])
  })

  it('uses a models command and efforts from the configuration', async () => {
    const catalog = await discoverModels(
      'mine',
      config('harnesses:\n  mine:\n    command: mine\n    models: {command: sh, args: [-c, list]}\n    efforts: [fast, deep]\n'),
      { run: responder({ 'sh -c list': 'm1\nm2\n' }) },
    )
    expect(catalog).toMatchObject({ models: [{ id: 'm1' }, { id: 'm2' }], efforts: ['fast', 'deep'] })
  })

  it('reports a failing models command', async () => {
    const catalog = await discoverModels('pi', config(), { run: responder({}), claudeModels: async () => CLAUDE_MODELS })
    expect(catalog).toMatchObject({ models: [], error: expect.stringContaining('not found') })
  })

  it('has no catalog for a harness without a models command', async () => {
    expect(await discoverModels('openhands', config(), { run: responder({}), claudeModels: async () => CLAUDE_MODELS })).toMatchObject({ models: [] })
  })
})

describe('model helpers', () => {
  const catalog = { models: [{ id: 'gpt-6-luna', efforts: ['low', 'high'] }], efforts: ['low', 'medium'], fetchedAt: '2026-10-06T00:00:00.000Z' }

  it('checks models against a catalog', () => {
    expect(modelKnown(catalog, 'gpt-6-luna')).toBe(true)
    expect(modelKnown(catalog, 'gpt-7')).toBe(false)
    expect(modelKnown({ models: [], fetchedAt: '' }, 'anything')).toBe(true)
  })

  it('picks the efforts of the model, then of the harness', () => {
    expect(effortsFor(catalog, 'gpt-6-luna')).toEqual(['low', 'high'])
    expect(effortsFor(catalog, 'other')).toEqual(['low', 'medium'])
    expect(effortsFor(undefined, 'x')).toBeUndefined()
  })

  it('recognizes unknown-model errors of the harnesses', () => {
    expect(isModelError('[claude-code:unrecognized_model] {"model":"opus-5.5"}')).toBe(true)
    expect(isModelError("The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.")).toBe(true)
    expect(isModelError('ProviderModelNotFoundError: litellm/qwen9')).toBe(true)
    expect(isModelError('tests are red')).toBe(false)
  })

  it('caches catalogs in a file', () => {
    const file = join(tempDir(), 'models.json')
    new ModelCache(file).set('codex', catalog)
    expect(new ModelCache(file).get('codex')).toEqual(catalog)
  })
})

describe('conveyor models', () => {
  it('lists the models of the harnesses in use', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const result = await runCli(['models', '--json'], {
      cwd: init.context.cwd,
      home: init.context.home,
      responses: { 'codex debug models': { code: 0, stdout: CODEX_CATALOG } },
    })
    const output = JSON.parse(result.stdout) as Record<string, { models: { id: string }[] }>
    expect(Object.keys(output)).toEqual(['claude'])
    expect(output.claude?.models.map((model) => model.id)).toContain('claude-opus-5-5')

    const codex = await runCli(['models', 'codex'], {
      cwd: init.context.cwd,
      home: init.context.home,
      responses: { 'codex debug models': { code: 0, stdout: CODEX_CATALOG } },
    })
    expect(codex.stdout).toContain('gpt-6-luna  (low, medium, high)')
  })
})

describe('conveyor run with unknown models', () => {
  it('warns at start about a model the harness does not list', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const context = { cwd: init.context.cwd, home: init.context.home, board: new FakeBoard('me') }
    await runCli(['config', 'set', 'stages.plan.model', 'opus-5.5'], context)
    const result = await runCli(['run', '--once'], context)
    expect(result.stderr).toContain('Stage plan uses model opus-5.5, which claude does not list')
    expect(result.stderr).toContain('conveyor models claude')
  })
})
