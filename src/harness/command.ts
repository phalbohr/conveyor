import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_USAGE, RESULT_SCHEMA, childEnv, failed, parseResult, type Harness, type StageOutput, type StageRun } from './harness.js'
import { spawnLines } from './process.js'

export type CommandDefinition = {
  command: string
  args: string[]
  env: Record<string, string>
  models?: { command?: string; args: string[] }
  efforts?: string[]
  interactive?: string[]
}

const NOISE = /^(Performing one time database migration|sqlite-migration:|Database migration complete)/

export class CommandHarness implements Harness {
  constructor(
    private readonly definition: CommandDefinition,
    private readonly options: { env?: NodeJS.ProcessEnv } = {},
  ) {}

  async runStage(run: StageRun): Promise<StageOutput> {
    const dir = mkdtempSync(join(tmpdir(), 'conveyor-result-'))
    const result = join(dir, 'result.json')
    const artifact = join(dir, 'artifact.md')
    try {
      const prompt = `${run.prompt}\n## Result file\n\nWhen you finish, write the structured result as JSON to the file in the environment variable CONVEYOR_RESULT (${result}). If the stage gives an artifact (for example a Markdown plan), first write its full text as plain text to the file in the environment variable CONVEYOR_ARTIFACT (${artifact}), and in the JSON set only \`artifact.kind\` and leave out \`artifact.content\`: the conveyor reads the content from that file. The JSON must match this schema:\n\n${JSON.stringify(COMMAND_RESULT_SCHEMA)}\n`
      const values: Record<string, string> = { prompt, model: run.model, effort: run.effort, workspace: run.cwd, result, artifact, temp: dir }
      const fill = (text: string) => text.replace(/\{(prompt|model|effort|workspace|result|artifact|temp)\}/g, (_, key: string) => values[key] ?? '')
      const args = this.definition.args.map(fill)
      const env = Object.fromEntries(Object.entries(this.definition.env).map(([key, value]) => [key, fill(value)]))
      let tail: string[] = []
      const exit = await spawnLines(this.definition.command, args, {
        cwd: run.cwd,
        env: { ...childEnv(this.options.env ?? process.env), ...env, CONVEYOR_RESULT: result, CONVEYOR_ARTIFACT: artifact },
        ...(run.signal ? { signal: run.signal } : {}),
        onLine: (line) => {
          run.onEvent?.()
          tail = [...tail.slice(-19), line]
        },
        ...(run.onEvent ? { onBusy: run.onEvent } : {}),
      })

      if (exit.aborted) return { result: failed('stage aborted'), usage: NO_USAGE }
      if (!existsSync(result)) {
        const stderr = exit.stderr.split('\n').filter((line) => !NOISE.test(line)).join('\n').trim()
        const reason = exit.error ?? ([stderr, tail.join('\n')].filter(Boolean).join('\n') || `${this.definition.command} exited with code ${exit.code}`)
        return { result: failed(`no result file (${this.definition.command} exited with code ${exit.code}): ${reason.replace(/\x1b\[[0-9;]*m/g, '').slice(-2000)}`), usage: NO_USAGE }
      }
      const text = readFileSync(result, 'utf8')
      const value = parseJson(text)
      if (value === undefined) return { result: failed(`the agent wrote a result file that is not JSON: ${text.trim().slice(0, 300) || '(empty)'}`), usage: NO_USAGE }
      const filled = withArtifact(value, artifact)
      if (missingContent(filled)) return { result: failed('the result names an artifact, but the artifact file is empty and artifact.content is missing'), usage: NO_USAGE }
      return { result: parseResult(filled), usage: NO_USAGE }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const COMMAND_RESULT_SCHEMA = {
  ...RESULT_SCHEMA,
  properties: {
    ...RESULT_SCHEMA.properties,
    artifact: {
      anyOf: [
        { type: 'null' },
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string' }, content: { type: 'string' } } },
      ],
    },
  },
}

function withArtifact(value: unknown, file: string): unknown {
  const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!content.trim() || typeof value !== 'object' || value === null) return value
  const { artifact } = value as { artifact?: unknown }
  if (typeof artifact !== 'object' || artifact === null) return value
  return { ...value, artifact: { ...artifact, content } }
}

function missingContent(value: unknown): boolean {
  const artifact = typeof value === 'object' && value !== null ? (value as { artifact?: unknown }).artifact : undefined
  return typeof artifact === 'object' && artifact !== null && !('content' in artifact)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
