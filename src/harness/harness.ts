import { z } from 'zod'

export type StageResult = {
  outcome: 'done' | 'needs_input' | 'approval' | 'failed'
  summary: string
  artifact?: { kind: string; content: string }
  questions?: string[]
  workpad?: string
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
}

export type StageOutput = { result: StageResult; usage: Usage }

export interface Harness {
  runStage(run: StageRun): Promise<StageOutput>
}

export type HarnessOptions = { command?: string; env?: NodeJS.ProcessEnv }

export const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'artifact', 'questions', 'workpad'],
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
  },
} as const

const resultSchema = z.object({
  outcome: z.enum(['done', 'needs_input', 'approval', 'failed']),
  summary: z.string(),
  artifact: z.object({ kind: z.string(), content: z.string() }).nullish(),
  questions: z.array(z.string()).nullish(),
  workpad: z.string().nullish(),
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
  const { outcome, summary, artifact, questions, workpad } = parsed.data
  return {
    outcome,
    summary,
    ...(artifact ? { artifact } : {}),
    ...(questions?.length ? { questions } : {}),
    ...(workpad ? { workpad } : {}),
  }
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !BOARD_CREDENTIALS.includes(key)))
}
