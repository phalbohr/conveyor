import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, isMap, parseDocument, YAMLMap, type Pair, type Scalar } from 'yaml'
import { loadConfig, type Config } from './config.js'

export type FieldKind = 'select' | 'text' | 'number' | 'boolean'

export type Field = {
  key: string
  group: 'Team' | 'Stages' | 'Personal'
  label: string
  kind: FieldKind
  value: string
  options?: string[]
}

type Spec = { key: string; label: string; kind: FieldKind; options?: string[] }

const FILES = { config: 'config.yaml', local: 'local.yaml' } as const
const RESERVED = ['story', 'plan', 'merge']
const STAGE_NAME = /^[a-z][a-z0-9-]*$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const BOOLEAN = ['true', 'false']

const TEAM: Spec[] = [
  { key: 'pickup_from', label: 'Pick up tasks from', kind: 'select', options: ['idea', 'story', 'plan'] },
  { key: 'transitions.idea_to_story', label: 'Gate idea → story', kind: 'select', options: ['interactive', 'autonomous', 'smart'] },
  { key: 'transitions.story_to_plan', label: 'Gate story → plan', kind: 'select', options: ['interactive', 'autonomous', 'smart'] },
  { key: 'transitions.merge', label: 'Merge mode', kind: 'select', options: ['human', 'ai', 'smart'] },
  { key: 'merge_method', label: 'Merge method', kind: 'select', options: ['merge', 'squash', 'rebase'] },
  { key: 'review.approvals', label: 'Approvals for merge', kind: 'number' },
  { key: 'language.docs', label: 'Documentation language', kind: 'text' },
]

const PERSONAL: Spec[] = [
  { key: 'limits.running', label: 'Tasks running at once', kind: 'number' },
  { key: 'limits.awaiting_me', label: 'Tasks waiting for my answer', kind: 'number' },
  { key: 'limits.awaiting_review', label: 'Tasks waiting for my review', kind: 'number' },
  { key: 'limits.daily_tokens', label: 'Daily token limit (0 = off)', kind: 'number' },
  { key: 'limits.subscription.five_hour_reserve', label: 'Five-hour window reserve, %', kind: 'number' },
  { key: 'limits.subscription.seven_day_reserve', label: 'Seven-day window reserve, %', kind: 'number' },
  { key: 'limits.subscription.probe', label: 'Probe subscription windows', kind: 'boolean', options: BOOLEAN },
  { key: 'poll_interval', label: 'Board poll interval', kind: 'text' },
  { key: 'pickup.include_unassigned', label: 'Take unassigned tasks', kind: 'boolean', options: BOOLEAN },
  { key: 'language.chat', label: 'My chat language', kind: 'text' },
]

export class SettingsDocument {
  private readonly docs: Record<keyof typeof FILES, Document>
  private readonly saved: Record<keyof typeof FILES, string>
  private config: Config | undefined
  private changed = false

  constructor(private readonly dir: string) {
    const read = (file: string) => {
      try {
        return readFileSync(join(dir, file), 'utf8')
      } catch {
        return ''
      }
    }
    this.saved = { config: read(FILES.config), local: read(FILES.local) }
    this.docs = { config: parseDocument(this.saved.config), local: parseDocument(this.saved.local) }
    const loaded = this.validateText()
    if (loaded.ok) this.config = loaded.config
  }

  fields(): Field[] {
    const config = this.config
    const harnesses = ['claude', 'codex', ...Object.keys(config?.harnesses ?? {})]
    const fields: Field[] = TEAM.map((spec) => this.field('Team', 'config', spec))
    for (const prefix of ['defaults', 'triage']) {
      fields.push(
        this.field('Team', 'config', { key: `${prefix}.harness`, label: `${prefix} harness`, kind: 'select', options: harnesses }),
        this.field('Team', 'config', { key: `${prefix}.model`, label: `${prefix} model`, kind: 'text' }),
        this.field('Team', 'config', { key: `${prefix}.effort`, label: `${prefix} effort`, kind: 'select', options: EFFORTS }),
      )
    }
    const stages = config?.stages ?? []
    const merge = stages.findIndex((stage) => stage.name === 'merge')
    stages.forEach((stage, index) => {
      fields.push(
        this.field('Stages', 'config', { key: `stages.${stage.name}.harness`, label: `${stage.name}: harness`, kind: 'select', options: harnesses }),
        this.field('Stages', 'config', { key: `stages.${stage.name}.model`, label: `${stage.name}: model`, kind: 'text' }),
        this.field('Stages', 'config', { key: `stages.${stage.name}.effort`, label: `${stage.name}: effort`, kind: 'select', options: EFFORTS }),
      )
      if (index > merge) {
        fields.push(this.field('Stages', 'config', { key: `stages.${stage.name}.when`, label: `${stage.name}: run when`, kind: 'select', options: ['success', 'failure', 'always'] }))
      }
    })
    fields.push(...PERSONAL.map((spec) => this.field('Personal', 'local', spec)))
    return fields
  }

  set(key: string, value: string) {
    const field = this.fields().find((candidate) => candidate.key === key)
    if (!field) throw new Error(`unknown field ${key}`)
    const doc = this.docs[field.group === 'Personal' ? 'local' : 'config']
    const path = key.split('.')
    if (value === '' && (field.group === 'Stages' || key.startsWith('defaults.') || key.startsWith('triage.'))) {
      if (doc.hasIn(path)) doc.deleteIn(path)
    } else {
      doc.setIn(path, field.kind === 'number' ? Number(value) : field.kind === 'boolean' ? value === 'true' : value)
    }
    this.refresh()
  }

  stageNames(): string[] {
    return this.stagesMap().items.map((pair) => String((pair.key as Scalar).value))
  }

  addStage(name: string, position: 'before-merge' | 'after-merge', when?: 'success' | 'failure' | 'always') {
    if (!STAGE_NAME.test(name)) throw new Error('stage names use lowercase letters, digits, and hyphens')
    if (this.stageNames().includes(name) || (this.config?.stages ?? []).some((stage) => stage.name === name)) throw new Error(`stage ${name} already exists`)
    const map = this.stagesMap()
    const entry = this.flowPair(name, position === 'after-merge' && when ? { when } : {})
    const mergeIndex = map.items.findIndex((pair) => (pair.key as Scalar).value === 'merge')
    if (position === 'before-merge') {
      if (mergeIndex >= 0) map.items.splice(mergeIndex, 0, entry)
      else map.items.push(entry)
    } else {
      if (mergeIndex < 0) map.items.push(this.flowPair('merge', {}))
      map.items.push(entry)
    }
    this.refresh()
  }

  removeStage(name: string) {
    if (RESERVED.includes(name)) throw new Error(`stage ${name} is reserved`)
    const map = this.stagesMap()
    map.items = map.items.filter((pair) => (pair.key as Scalar).value !== name)
    this.refresh()
  }

  moveStage(name: string, delta: -1 | 1) {
    const items = this.stagesMap().items
    const index = items.findIndex((pair) => (pair.key as Scalar).value === name)
    const target = index + delta
    if (index < 0 || target < 0 || target >= items.length) return
    const [moved] = items.splice(index, 1)
    if (moved) items.splice(target, 0, moved)
    this.refresh()
  }

  validate(): { ok: true } | { ok: false; errors: string[] } {
    const loaded = this.validateText()
    return loaded.ok ? { ok: true } : { ok: false, errors: loaded.errors }
  }

  save(): { ok: true } | { ok: false; errors: string[] } {
    const result = this.validate()
    if (!result.ok) return result
    for (const name of ['config', 'local'] as const) {
      const text = this.text(name)
      if (text !== this.saved[name]) writeFileSync(join(this.dir, FILES[name]), text)
      this.saved[name] = text
    }
    this.changed = false
    return result
  }

  dirty() {
    return this.changed
  }

  private text(name: keyof typeof FILES) {
    return this.docs[name].toString({ flowCollectionPadding: false, lineWidth: 0 })
  }

  private field(group: Field['group'], file: keyof typeof FILES, spec: Spec): Field {
    const raw = this.docs[file].getIn(spec.key.split('.'))
    const effective = group === 'Stages' ? undefined : pick(this.config, spec.key)
    const value = raw ?? effective
    return { ...spec, group, value: value === undefined || value === null ? '' : String(value) }
  }

  private stagesMap(): YAMLMap {
    const doc = this.docs.config
    let map = doc.get('stages')
    if (!isMap(map)) {
      map = new YAMLMap()
      doc.set('stages', map)
    }
    return map as YAMLMap
  }

  private flowPair(name: string, value: Record<string, string>): Pair {
    const node = this.docs.config.createNode(value)
    node.flow = true
    return this.docs.config.createPair(name, node) as Pair
  }

  private refresh() {
    this.changed = true
    const loaded = this.validateText()
    if (loaded.ok) this.config = loaded.config
  }

  private validateText() {
    const dir = mkdtempSync(join(tmpdir(), 'conveyor-settings-check-'))
    try {
      writeFileSync(join(dir, FILES.config), this.text('config'))
      writeFileSync(join(dir, FILES.local), this.text('local'))
      return loadConfig(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function pick(config: Config | undefined, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined), config)
}
