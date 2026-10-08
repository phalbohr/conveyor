import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, isMap, parseDocument, YAMLMap, type Pair, type Scalar } from 'yaml'
import { PERMISSION_MODES, loadConfig, type Config } from './config.js'
import { effortsFor, modelKnown, type Catalog } from './models.js'
import { stageCatalog, stageStub } from './stage-catalog.js'

export type FieldKind = 'select' | 'text' | 'number' | 'boolean'

export type Field = {
  key: string
  group: 'Team' | 'Stages' | 'Stage files' | 'Personal'
  label: string
  kind: FieldKind
  value: string
  help: string
  options?: string[]
  other?: boolean
  inherited?: string
}

type Spec = { key: string; label: string; kind: FieldKind; help: string; options?: string[]; other?: boolean; optionHelp?: Record<string, string> }

const FILES = { config: 'config.yaml', local: 'local.yaml' } as const
const RESERVED = ['story', 'plan', 'merge']
const STAGE_NAME = /^[a-z][a-z0-9-]*$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const BOOLEAN = ['true', 'false']

const GATE = ['interactive', 'autonomous', 'smart']
const gateHelp = (gate: string) => ({
  interactive: `the agent asks questions and waits for your approval of the ${gate}`,
  autonomous: `the agent writes the ${gate} alone, without questions or approval`,
  smart: `the agent asks only in the cases listed in smart/${gate === 'story' ? 'idea-story' : 'story-plan'}.md`,
})
const STAGE_KEYS: Record<string, string> = { permission_mode: 'permissionMode' }

const TEAM: Spec[] = [
  {
    key: 'pickup_from',
    label: 'Pick up tasks from',
    kind: 'select',
    options: ['idea', 'story', 'plan'],
    help: 'earliest form:: label the conveyor takes',
    optionHelp: {
      idea: 'takes form::idea, story, and plan; agents write the story and the plan',
      story: 'takes form::story and plan; agents write the plan',
      plan: 'takes form::plan only; agents start with implementation',
    },
  },
  { key: 'transitions.idea_to_story', label: 'Gate idea → story', kind: 'select', options: GATE, help: 'who decides when an idea becomes a story', optionHelp: gateHelp('story') },
  { key: 'transitions.story_to_plan', label: 'Gate story → plan', kind: 'select', options: GATE, help: 'who decides when a story gets its plan', optionHelp: gateHelp('plan') },
  {
    key: 'transitions.merge',
    label: 'Merge mode',
    kind: 'select',
    options: ['human', 'ai', 'smart'],
    help: 'who decides about the merge',
    optionHelp: {
      human: 'a human reviews the pull request and writes /merge or approves',
      ai: 'the conveyor merges when the merge stage is done and checks pass',
      smart: 'the merge stage decides by smart/merge.md: merge or ask a human',
    },
  },
  { key: 'merge_method', label: 'Merge method', kind: 'select', options: ['merge', 'squash', 'rebase'], help: 'how the pull request is merged' },
  {
    key: 'close_on_done',
    label: 'Close issues when done',
    kind: 'boolean',
    options: BOOLEAN,
    help: 'who closes a finished issue',
    optionHelp: { false: 'done issues stay open until a human closes them, e.g. after a sprint review', true: 'the conveyor closes the issue when the task is done' },
  },
  { key: 'review.approvals', label: 'Approvals for merge', kind: 'number', help: 'distinct people who approve before the conveyor merges' },
  { key: 'language.docs', label: 'Documentation language', kind: 'text', help: 'language of everything the team sees' },
  { key: 'board.github_project', label: 'GitHub project number', kind: 'number', help: 'GitHub only: the project whose Conveyor field shows the task state as columns' },
]

const PERSONAL: Spec[] = [
  { key: 'limits.running', label: 'Tasks running at once', kind: 'number', help: 'stages this machine runs in parallel' },
  { key: 'limits.awaiting_me', label: 'Tasks waiting for my answer', kind: 'number', help: 'no new tasks while this many wait for you' },
  { key: 'limits.awaiting_review', label: 'Tasks waiting for my review', kind: 'number', help: 'no new tasks while this many wait for your review' },
  { key: 'limits.daily_tokens', label: 'Daily token limit (0 = off)', kind: 'number', help: 'no new tasks after this many tokens a day' },
  { key: 'limits.subscription.five_hour_reserve', label: 'Five-hour window reserve, %', kind: 'number', help: 'part of the 5-hour subscription window kept for you' },
  { key: 'limits.subscription.seven_day_reserve', label: 'Seven-day window reserve, %', kind: 'number', help: 'part of the 7-day subscription window kept for you' },
  { key: 'limits.subscription.probe', label: 'Probe subscription windows', kind: 'boolean', options: BOOLEAN, help: 'cheap check every 10 min, sees your own sessions too' },
  { key: 'poll_interval', label: 'Board poll interval', kind: 'text', help: 'how often `run` checks the board, e.g. 5m' },
  { key: 'pickup.include_unassigned', label: 'Take unassigned tasks', kind: 'boolean', options: BOOLEAN, help: 'also take tasks nobody is assigned to' },
  { key: 'language.chat', label: 'My chat language', kind: 'text', help: 'language of `new` and `attach` sessions' },
]

const PREFIX_HELP: Record<string, string> = {
  defaults: 'used by stages without their own value',
  triage: 'agent that orders new tasks and sets blockers',
}

const STAGE_HELP: Record<string, string> = {
  harness: 'agent CLI that runs the stage',
  model: 'model name for that harness',
  effort: 'reasoning effort',
  when: 'after merge: run on success, failure, or always',
  permission_mode: 'claude tool permissions',
}

const PERMISSION_HELP: Record<string, string> = {
  bypassPermissions: 'every tool without asking',
  auto: 'a classifier blocks risky actions',
  acceptEdits: 'file edits; other tools only by allow rules in .claude/settings.json',
  dontAsk: 'only tools allowed in .claude/settings.json',
}

export class SettingsDocument {
  private readonly docs: Record<keyof typeof FILES, Document>
  private readonly saved: Record<keyof typeof FILES, string>
  private config: Config | undefined
  private changed = false
  private readonly added = new Set<string>()

  private catalogs: Record<string, Catalog>

  constructor(
    private readonly dir: string,
    options: { catalogs?: Record<string, Catalog> } = {},
  ) {
    this.catalogs = options.catalogs ?? {}
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

  setCatalogs(catalogs: Record<string, Catalog>) {
    this.catalogs = catalogs
  }

  fields(): Field[] {
    const config = this.config
    const harnesses = ['claude', 'codex', ...Object.keys(config?.harnesses ?? {})]
    const fields: Field[] = TEAM.map((spec) => this.field('Team', 'config', spec))
    for (const prefix of ['defaults', 'triage']) {
      const help = PREFIX_HELP[prefix] ?? ''
      const harness = prefix === 'triage' ? (config?.triage.harness ?? 'claude') : String(this.docs.config.getIn(['defaults', 'harness']) ?? 'claude')
      const model = prefix === 'triage' ? (config?.triage.model ?? '') : String(this.docs.config.getIn(['defaults', 'model']) ?? 'sonnet')
      fields.push(
        this.field('Team', 'config', { key: `${prefix}.harness`, label: `${prefix} harness`, kind: 'select', options: harnesses, help }),
        ...this.modelFields(prefix, `${prefix} `, harness, model, { model: help, effort: help }).map((spec) => this.field('Team', 'config', spec)),
      )
    }
    const stages = config?.stages ?? []
    const merge = stages.findIndex((stage) => stage.name === 'merge')
    stages.forEach((stage, index) => {
      fields.push(
        this.field('Stages', 'config', { key: `stages.${stage.name}.harness`, label: `${stage.name}: harness`, kind: 'select', options: harnesses, help: STAGE_HELP.harness ?? '' }),
        ...this.modelFields(`stages.${stage.name}`, `${stage.name}: `, stage.harness, stage.model, { model: STAGE_HELP.model ?? '', effort: STAGE_HELP.effort ?? '' }).map((spec) =>
          this.field('Stages', 'config', spec),
        ),
      )
      if (stage.harness === 'claude') {
        fields.push(
          this.field('Stages', 'config', {
            key: `stages.${stage.name}.permission_mode`,
            label: `${stage.name}: permissions`,
            kind: 'select',
            options: [...PERMISSION_MODES],
            help: STAGE_HELP.permission_mode ?? '',
            optionHelp: PERMISSION_HELP,
          }),
        )
      }
      if (index > merge) {
        fields.push(
          this.field('Stages', 'config', { key: `stages.${stage.name}.when`, label: `${stage.name}: run when`, kind: 'select', options: ['success', 'failure', 'always'], help: STAGE_HELP.when ?? '' }),
        )
      }
    })
    for (const entry of config ? stageCatalog(this.dir, config) : []) {
      const file = `stages/${entry.name}.md`
      const help = entry.reserved ? `reserved, always on · ${file}` : entry.described ? file : `no description yet: write it in ${file}`
      fields.push({ key: `stage-files.${entry.name}`, group: 'Stage files', label: entry.name, kind: 'select', options: ['on', 'off'], value: entry.enabled ? 'on' : 'off', help: entry.described || entry.reserved ? help : `⚠ ${help}` })
    }
    fields.push(...PERSONAL.map((spec) => this.field('Personal', 'local', spec)))
    return fields
  }

  set(key: string, value: string) {
    if (key.startsWith('stage-files.')) {
      const name = key.slice('stage-files.'.length)
      const enabled = this.stageNames().includes(name) || (this.config?.stages ?? []).some((stage) => stage.name === name)
      if (value === 'on' && !enabled) this.addStage(name, 'before-merge')
      if (value === 'off' && enabled) this.removeStage(name)
      return
    }
    const field = this.fields().find((candidate) => candidate.key === key)
    if (!field) throw new Error(`unknown field ${key}`)
    const doc = this.docs[field.group === 'Personal' ? 'local' : 'config']
    const path = key.split('.')
    if (path.at(-1) === 'harness' && value) this.retarget(path.slice(0, -1), value)
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
    this.added.add(name)
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

  problems(): string[] {
    const loaded = this.validateText()
    return loaded.ok ? [] : loaded.errors
  }

  validate(): { ok: true } | { ok: false; errors: string[] } {
    const loaded = this.validateText()
    return loaded.ok ? { ok: true } : { ok: false, errors: loaded.errors }
  }

  save(): { ok: true; created?: string[] } | { ok: false; errors: string[] } {
    const result = this.validate()
    if (!result.ok) return result
    for (const name of ['config', 'local'] as const) {
      const text = this.text(name)
      if (text !== this.saved[name]) writeFileSync(join(this.dir, FILES[name]), text)
      this.saved[name] = text
    }
    const created: string[] = []
    for (const name of this.added) {
      const path = join(this.dir, 'stages', `${name}.md`)
      if (!this.stageNames().includes(name) || existsSync(path)) continue
      mkdirSync(join(this.dir, 'stages'), { recursive: true })
      writeFileSync(path, stageStub(name))
      created.push(`stages/${name}.md`)
    }
    this.added.clear()
    this.changed = false
    return created.length > 0 ? { ok: true, created } : { ok: true }
  }

  dirty() {
    return this.changed
  }

  private text(name: keyof typeof FILES) {
    return this.docs[name].toString({ flowCollectionPadding: false, lineWidth: 0 })
  }

  private modelFields(prefix: string, label: string, harness: string, model: string, help: { model: string; effort: string }): Spec[] {
    const catalog = this.catalogs[harness]
    const ids = catalog?.models.map((entry) => entry.id) ?? []
    const efforts = effortsFor(catalog, model) ?? (harness === 'claude' || harness === 'codex' ? EFFORTS : undefined)
    const source = ids.length ? `${help.model} · ${harness} models` : `${help.model} · any name ${harness} accepts`
    return [
      ids.length
        ? { key: `${prefix}.model`, label: `${label}model`, kind: 'select', options: ids, other: true, help: source }
        : { key: `${prefix}.model`, label: `${label}model`, kind: 'text', help: source },
      efforts
        ? { key: `${prefix}.effort`, label: `${label}effort`, kind: 'select', options: efforts, help: help.effort }
        : { key: `${prefix}.effort`, label: `${label}effort`, kind: 'text', help: help.effort },
    ]
  }

  private retarget(prefix: string[], harness: string) {
    const doc = this.docs.config
    const drop = (key: string) => doc.hasIn([...prefix, key]) && doc.deleteIn([...prefix, key])
    if (harness !== 'claude') drop('permission_mode')
    if (harness !== 'codex') {
      drop('sandbox')
      drop('network')
    }
    const own = (key: string) => doc.getIn([...prefix, key]) as string | undefined
    const inherited = (key: string) => (prefix[0] === 'defaults' ? undefined : (doc.getIn(['defaults', key]) as string | undefined))
    const catalog = this.catalogs[harness]
    const model = own('model') ?? inherited('model')
    if (catalog?.models.length && !(model && modelKnown(catalog, model))) doc.setIn([...prefix, 'model'], catalog.models[0]?.id)
    else if (!catalog?.models.length) drop('model')
    const effort = own('effort') ?? inherited('effort')
    const efforts = effortsFor(catalog, String(doc.getIn([...prefix, 'model']) ?? model ?? '')) ?? (harness === 'claude' || harness === 'codex' ? EFFORTS : undefined)
    if (efforts && !(effort && efforts.includes(effort))) doc.setIn([...prefix, 'effort'], efforts.includes('medium') ? 'medium' : efforts[0])
    else if (!efforts) drop('effort')
  }

  private field(group: Field['group'], file: keyof typeof FILES, spec: Spec): Field {
    const path = spec.key.split('.')
    const raw = this.docs[file].getIn(path)
    const effective = group === 'Stages' ? undefined : pick(this.config, spec.key)
    const value = raw ?? effective
    const text = value === undefined || value === null ? '' : String(value)
    const options = spec.options && text && !spec.options.includes(text) ? [text, ...spec.options] : spec.options
    const inherited = this.inherited(path)
    const { optionHelp, ...rest } = spec
    return { ...rest, help: optionHelp?.[text || inherited || ''] ?? spec.help, ...(options ? { options } : {}), ...(inherited ? { inherited } : {}), group, value: text }
  }

  private inherited(path: string[]): string | undefined {
    const [scope, name, key] = path
    if (scope === 'stages' && name && key) {
      const stage = this.config?.stages.find((entry) => entry.name === name) as Record<string, unknown> | undefined
      const value = stage?.[STAGE_KEYS[key] ?? key]
      return value === undefined ? undefined : String(value)
    }
    if (scope === 'triage' && name) {
      const value = (this.config?.triage as Record<string, unknown> | undefined)?.[name]
      return value === undefined ? undefined : String(value)
    }
    return undefined
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
