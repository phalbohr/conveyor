import type { Context } from '../cli.js'
import { SettingsDocument } from '../settings-editor.js'
import { findSettings } from '../settings.js'

type Edit = (doc: SettingsDocument) => string

export function configList(context: Context, json: boolean): number {
  const doc = open(context)
  if (!doc) return 1
  const fields = doc.fields()
  if (json) {
    context.stdout(`${JSON.stringify(fields)}\n`)
    return 0
  }
  let group = ''
  for (const field of fields) {
    if (field.group !== group) {
      group = field.group
      context.stdout(`\n${group}\n`)
    }
    const options = field.options ? ` [${field.options.join('|')}]` : ''
    context.stdout(`  ${field.key} = ${field.value || '(inherit)'}${options}\n      ${field.help}\n`)
  }
  return 0
}

export function configGet(context: Context, key: string, json: boolean): number {
  const doc = open(context)
  if (!doc) return 1
  const field = doc.fields().find((candidate) => candidate.key === key)
  if (!field) return fail(context, `unknown setting ${key}. Run \`conveyor config list\` to see all settings.`)
  context.stdout(json ? `${JSON.stringify(field)}\n` : `${field.value}\n`)
  return 0
}

export function configEdit(context: Context, edit: Edit): number {
  const doc = open(context)
  if (!doc) return 1
  let done: string
  try {
    done = edit(doc)
  } catch (error) {
    return fail(context, (error as Error).message)
  }
  const saved = doc.save()
  if (!saved.ok) return fail(context, `Not saved, the configuration would be invalid:\n${saved.errors.join('\n')}`)
  context.stdout(`${done}\n`)
  return 0
}

function open(context: Context): SettingsDocument | undefined {
  const settings = findSettings(context.cwd, context.home)
  if (!settings) {
    context.stderr(`No conveyor settings found in ${context.cwd}. Run \`conveyor init\`.\n`)
    return undefined
  }
  return new SettingsDocument(settings)
}

function fail(context: Context, message: string) {
  context.stderr(`${message}\n`)
  return 1
}
