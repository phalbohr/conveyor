import { join } from 'node:path'
import { probesOf, type Context } from '../cli.js'
import { loadConfig, type Config } from '../config.js'
import { ModelCache, catalogsFor } from '../models.js'
import { findSettings } from '../settings.js'

const BUILT_IN = ['claude', 'codex']

export function modelsFile(home: string, project: string) {
  return join(home, '.conveyor', 'models', `${project.replaceAll('/', '-')}.json`)
}

export function harnessesInUse(config: Config) {
  return [...new Set([config.triage.harness, ...config.stages.map((stage) => stage.harness)])]
}

export async function modelsCommand(context: Context, harness: string | undefined, options: { refresh?: boolean }, json: boolean): Promise<number> {
  const settings = findSettings(context.cwd, context.home)
  if (!settings) {
    context.stderr(`No conveyor settings found in ${context.cwd}. Run \`conveyor init\`.\n`)
    return 1
  }
  const loaded = loadConfig(settings)
  if (!loaded.ok) {
    context.stderr(`${loaded.errors.join('\n')}\n`)
    return 1
  }
  const config = loaded.config
  if (harness && !BUILT_IN.includes(harness) && !config.harnesses[harness]) {
    context.stderr(`Unknown harness ${harness}. Known: ${[...BUILT_IN, ...Object.keys(config.harnesses)].join(', ')}.\n`)
    return 1
  }
  const cache = new ModelCache(modelsFile(context.home, config.board.project))
  const catalogs = await catalogsFor(harness ? [harness] : harnessesInUse(config), config, probesOf(context), cache, options.refresh ?? false)
  if (json) {
    context.stdout(`${JSON.stringify(catalogs)}\n`)
    return 0
  }
  for (const [name, catalog] of Object.entries(catalogs)) {
    context.stdout(`${name}${catalog.efforts ? ` (efforts: ${catalog.efforts.join(', ')})` : ''}\n`)
    if (catalog.error) context.stdout(`  could not list models: ${catalog.error}\n`)
    else if (catalog.models.length === 0) context.stdout('  no model list: any model name the harness accepts works\n')
    for (const model of catalog.models) {
      const name = [model.label, model.aliases?.length ? `alias ${model.aliases.join(', ')}` : ''].filter(Boolean).join(', ')
      context.stdout(`  ${model.id}${name ? ` — ${name}` : ''}${model.efforts?.length ? `  (${model.efforts.join(', ')})` : ''}\n`)
    }
  }
  return 0
}
