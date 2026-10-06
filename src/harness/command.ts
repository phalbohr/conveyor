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
}

export class CommandHarness implements Harness {
  constructor(
    private readonly definition: CommandDefinition,
    private readonly options: { env?: NodeJS.ProcessEnv } = {},
  ) {}

  async runStage(run: StageRun): Promise<StageOutput> {
    const dir = mkdtempSync(join(tmpdir(), 'conveyor-result-'))
    const result = join(dir, 'result.json')
    try {
      const prompt = `${run.prompt}\n## Result file\n\nWhen you finish, write the structured result as JSON to the file in the environment variable CONVEYOR_RESULT (${result}). It must match this JSON schema:\n\n${JSON.stringify(RESULT_SCHEMA)}\n`
      const values: Record<string, string> = { prompt, model: run.model, effort: run.effort, workspace: run.cwd, result }
      const fill = (text: string) => text.replace(/\{(prompt|model|effort|workspace|result)\}/g, (_, key: string) => values[key] ?? '')
      const args = this.definition.args.map(fill)
      const env = Object.fromEntries(Object.entries(this.definition.env).map(([key, value]) => [key, fill(value)]))
      let tail: string[] = []
      const exit = await spawnLines(this.definition.command, args, {
        cwd: run.cwd,
        env: { ...childEnv(this.options.env ?? process.env), ...env, CONVEYOR_RESULT: result },
        ...(run.signal ? { signal: run.signal } : {}),
        onLine: (line) => {
          run.onEvent?.()
          tail = [...tail.slice(-19), line]
        },
      })

      if (exit.aborted) return { result: failed('stage aborted'), usage: NO_USAGE }
      if (!existsSync(result)) {
        const reason = exit.error ?? (exit.stderr.trim() || tail.join('\n') || `${this.definition.command} exited with code ${exit.code}`)
        return { result: failed(`no result file: ${reason.slice(-2000)}`), usage: NO_USAGE }
      }
      return { result: parseResult(parseJson(readFileSync(result, 'utf8'))), usage: NO_USAGE }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
