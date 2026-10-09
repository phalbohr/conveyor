import { z } from 'zod'
import type { PermissionMode } from '../config.js'
import type { ResolvedSkill } from '../skills.js'

export type StageResult = {
  outcome: 'done' | 'needs_input' | 'approval' | 'failed'
  summary: string
  artifact?: { kind: string; content: string }
  questions?: string[]
  workpad?: string
  parts?: string[]
}

export type Usage = { inputTokens: number; outputTokens: number }

export type StageRun = {
  taskId?: string
  stage?: string
  prompt: string
  model: string
  effort: string
  cwd: string
  signal?: AbortSignal
  onEvent?: () => void
  skills?: ResolvedSkill[]
  sandbox?: 'workspace-write' | 'full-access'
  network?: boolean
  permissionMode?: PermissionMode
}

export type QuotaWindow = { utilization: number; resetsAt: string }
export type Quota = { fiveHour?: QuotaWindow; sevenDay?: QuotaWindow }

export type StageOutput = { result: StageResult; usage: Usage; quota?: Quota }

export interface Harness {
  runStage(run: StageRun): Promise<StageOutput>
  probeQuota?(cwd: string): Promise<Quota | undefined>
}

export type HarnessOptions = { command?: string; env?: NodeJS.ProcessEnv }

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'artifact', 'questions', 'workpad', 'parts'],
  properties: {
    outcome: { type: 'string', enum: ['done', 'needs_input', 'approval', 'failed'] },
    summary: { type: 'string' },
    artifact: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'content'],
          properties: { kind: { type: 'string' }, content: { type: 'string' } },
        },
      ],
    },
    questions: { type: 'array', items: { type: 'string' } },
    workpad: { type: ['string', 'null'] },
    parts: { anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'string' } }] },
  },
} as const

const resultSchema = z.object({
  outcome: z.enum(['done', 'needs_input', 'approval', 'failed']),
  summary: z.string(),
  artifact: z.object({ kind: z.string(), content: z.string() }).nullish(),
  questions: z.array(z.string()).nullish(),
  workpad: z.string().nullish(),
  parts: z.array(z.string()).nullish(),
})

const BOARD_CREDENTIALS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GL_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_ACCESS_TOKEN',
]

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 }

export function failed(summary: string): StageResult {
  return { outcome: 'failed', summary }
}

export function parseResult(value: unknown): StageResult {
  const parsed = resultSchema.safeParse(value)
  if (!parsed.success) return failed(`invalid stage result: ${parsed.error.message}`)
  const { outcome, summary, artifact, questions, workpad, parts } = parsed.data
  return {
    outcome,
    summary,
    ...(artifact ? { artifact } : {}),
    ...(questions?.length ? { questions } : {}),
    ...(workpad ? { workpad } : {}),
    ...(parts && parts.length > 1 ? { parts } : {}),
  }
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !BOARD_CREDENTIALS.includes(key)))
}
