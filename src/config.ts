import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

const duration = z
  .string()
  .regex(/^\d+[smhd]$/, 'expected a duration such as 30s, 5m, 2h, or 4d')
  .transform((text) => Number(text.slice(0, -1)) * UNIT_MS[text.at(-1) as keyof typeof UNIT_MS])

const waiting = z
  .string()
  .regex(/^\d+w?d$/, 'expected calendar days such as 4d or working days such as 2wd')
  .transform((text) => ({ days: Number.parseInt(text, 10), working: text.endsWith('wd') }))

const harness = z.enum(['claude', 'codex'])
const name = z.string().min(1)
const count = z.int().positive()
const store = z.enum(['board', 'repo', 'path'])
const write = z.enum(['replace', 'append'])
const gateMode = z.enum(['interactive', 'autonomous', 'smart'])

const stageSettings = z.strictObject({
  harness: harness.optional(),
  model: name.optional(),
  effort: name.optional(),
})

const stageEntry = z.strictObject({
  ...stageSettings.shape,
  when: z.enum(['success', 'failure', 'always']).optional(),
  sandbox: z.enum(['workspace-write', 'full-access']).optional(),
  network: z.boolean().optional(),
})

const needsPath = (artifact: { store: string; path?: string | undefined }) => artifact.store === 'board' || artifact.path !== undefined
const pathRequired = { message: 'path is required for repo and path storage' }

const teamArtifact = z
  .strictObject({
    store: store.default('board'),
    path: name.optional(),
    write: write.default('replace'),
    allow_private: z.boolean().default(false),
  })
  .refine(needsPath, pathRequired)

const localArtifact = z
  .strictObject({ store, path: name.optional(), write: write.optional() })
  .refine(needsPath, pathRequired)

const teamSchema = z.strictObject({
  board: z.strictObject({ provider: z.enum(['github', 'gitlab']), project: name, github_project: count.optional() }),
  artifacts: z
    .strictObject({ idea: teamArtifact.prefault({}), story: teamArtifact.prefault({}), plan: teamArtifact.prefault({}) })
    .prefault({}),
  pickup_from: z.enum(['idea', 'story', 'plan']).default('plan'),
  transitions: z
    .strictObject({
      idea_to_story: gateMode.default('interactive'),
      story_to_plan: gateMode.default('interactive'),
      merge: z.enum(['human', 'ai', 'smart']).default('human'),
    })
    .prefault({}),
  defaults: z
    .strictObject({ harness: harness.default('claude'), model: name.default('sonnet'), effort: name.default('medium') })
    .prefault({}),
  triage: stageSettings.prefault({}),
  stages: z.record(z.string(), stageEntry).default({}),
  hooks: z
    .strictObject({
      after_create: z.string().optional(),
      before_run: z.string().optional(),
      after_run: z.string().optional(),
      before_remove: z.string().optional(),
      timeout: duration.prefault('60s'),
    })
    .prefault({}),
  timeouts: z
    .strictObject({
      stage: duration.prefault('60m'),
      stall: z.union([z.literal(0), duration]).prefault('5m'),
      heartbeat: duration.prefault('30m'),
      waiting: waiting.prefault('4d'),
    })
    .prefault({}),
  retry: z.strictObject({ max_backoff: duration.prefault('5m'), max_attempts: count.default(5) }).prefault({}),
  language: z.strictObject({ docs: name.default('English') }).prefault({}),
  merge_method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
})

const localSchema = z.strictObject({
  artifacts: z
    .strictObject({ idea: localArtifact.optional(), story: localArtifact.optional(), plan: localArtifact.optional() })
    .prefault({}),
  limits: z
    .strictObject({
      running: count.default(3),
      awaiting_me: count.default(5),
      awaiting_review: count.default(2),
      daily_tokens: z.int().nonnegative().default(0),
    })
    .prefault({}),
  poll_interval: duration.prefault('5m'),
  pickup: z.strictObject({ assignee: name.default('me'), include_unassigned: z.boolean().default(true) }).prefault({}),
  workspace: z.strictObject({ root: name.default('~/.conveyor/workspaces/{project}') }).prefault({}),
  language: z.strictObject({ chat: name.optional() }).prefault({}),
})

type Team = z.output<typeof teamSchema>
type Local = z.output<typeof localSchema>
type ArtifactKind = keyof Team['artifacts']

export type Harness = z.output<typeof harness>
export type StageSettings = { harness: Harness; model: string; effort: string }
export type Stage = StageSettings & {
  name: string
  when?: 'success' | 'failure' | 'always'
  sandbox?: 'workspace-write' | 'full-access'
  network?: boolean
}
export type Artifact = { store: 'board' | 'repo' | 'path'; path?: string; write: 'replace' | 'append' }

export type Config = Omit<Team, 'artifacts' | 'defaults' | 'triage' | 'stages' | 'language'> &
  Omit<Local, 'artifacts' | 'language'> & {
    language: { docs: string; chat?: string }
    artifacts: Record<ArtifactKind, Artifact>
    triage: StageSettings
    stages: Stage[]
  }

export type LoadResult = { ok: true; config: Config } | { ok: false; errors: string[] }

const CONFIG_FILE = 'config.yaml'
const LOCAL_FILE = 'local.yaml'
const STAGE_NAME = /^[a-z][a-z0-9-]*$/

export function loadConfig(settingsDir: string): LoadResult {
  const errors: string[] = []

  const configPath = join(settingsDir, CONFIG_FILE)
  if (!existsSync(configPath)) return { ok: false, errors: [`${CONFIG_FILE}: file not found in ${settingsDir}`] }
  const team = validate(CONFIG_FILE, readYaml(configPath, CONFIG_FILE, errors), teamSchema, errors)

  const localPath = join(settingsDir, LOCAL_FILE)
  const local = validate(LOCAL_FILE, existsSync(localPath) ? readYaml(localPath, LOCAL_FILE, errors) : {}, localSchema, errors)

  if (!team || !local || errors.length > 0) return { ok: false, errors }

  const artifacts = resolveArtifacts(team, local, errors)
  const stages = resolveStages(team, errors)
  if (errors.length > 0) return { ok: false, errors }

  const { artifacts: _teamArtifacts, defaults, triage, stages: _stages, language: teamLanguage, ...teamRest } = team
  const { artifacts: _localArtifacts, language: localLanguage, ...localRest } = local
  const language = { docs: teamLanguage.docs, ...(localLanguage.chat ? { chat: localLanguage.chat } : {}) }
  return {
    ok: true,
    config: { ...teamRest, ...localRest, language, artifacts, triage: withDefaults(triage, defaults), stages },
  }
}

function readYaml(path: string, file: string, errors: string[]): unknown {
  try {
    return parse(readFileSync(path, 'utf8')) ?? {}
  } catch (error) {
    errors.push(`${file}: ${(error as Error).message}`)
    return undefined
  }
}

function validate<T extends z.ZodType>(file: string, data: unknown, schema: T, errors: string[]): z.output<T> | undefined {
  if (data === undefined) return undefined
  const result = schema.safeParse(data)
  if (result.success) return result.data
  for (const issue of result.error.issues) errors.push(`${file}: ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  return undefined
}

function resolveArtifacts(team: Team, local: Local, errors: string[]): Record<ArtifactKind, Artifact> {
  const kinds = Object.keys(team.artifacts) as ArtifactKind[]
  return Object.fromEntries(
    kinds.map((kind) => {
      const { allow_private, ...shared } = team.artifacts[kind]
      const override = local.artifacts[kind]
      if (!override) return [kind, shared]
      if (!allow_private) errors.push(`${LOCAL_FILE}: artifacts.${kind}: the team does not allow private storage (allow_private)`)
      return [kind, { ...override, write: override.write ?? shared.write }]
    }),
  ) as Record<ArtifactKind, Artifact>
}

function resolveStages(team: Team, errors: string[]): Stage[] {
  const listed = Object.keys(team.stages)
  if (!listed.includes('story')) listed.unshift('story')
  if (!listed.includes('plan')) listed.splice(listed.indexOf('story') + 1, 0, 'plan')
  if (!listed.includes('merge')) listed.push('merge')

  const [story, plan, merge] = ['story', 'plan', 'merge'].map((stage) => listed.indexOf(stage)) as [number, number, number]
  if (!(story < plan && plan < merge)) errors.push(`${CONFIG_FILE}: stages: reserved stages must keep the order story, plan, merge`)

  return listed.map((stageName, index) => {
    const entry = team.stages[stageName] ?? {}
    const reserved = index === story || index === plan || index === merge
    const postMerge = index > merge
    if (!STAGE_NAME.test(stageName)) {
      errors.push(`${CONFIG_FILE}: stages.${stageName}: stage names use lowercase letters, digits, and hyphens`)
    }
    if (!reserved && index < plan) errors.push(`${CONFIG_FILE}: stages.${stageName}: custom stages must come after plan`)
    if (!postMerge && entry.when) errors.push(`${CONFIG_FILE}: stages.${stageName}: only post-merge stages can have when`)
    const stage: Stage = { name: stageName, ...withDefaults(entry, team.defaults) }
    if (stage.harness === 'codex') Object.assign(stage, { sandbox: entry.sandbox ?? 'workspace-write', network: entry.network ?? true })
    else if (entry.sandbox !== undefined || entry.network !== undefined) {
      errors.push(`${CONFIG_FILE}: stages.${stageName}: sandbox and network apply only to codex stages`)
    }
    if (postMerge) stage.when = entry.when ?? 'success'
    return stage
  })
}

function withDefaults(settings: z.output<typeof stageSettings>, defaults: StageSettings): StageSettings {
  return {
    harness: settings.harness ?? defaults.harness,
    model: settings.model ?? defaults.model,
    effort: settings.effort ?? defaults.effort,
  }
}
