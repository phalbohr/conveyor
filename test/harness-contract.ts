import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Harness } from '../src/harness/harness.js'
import { tempDir } from './helpers.js'

export function harnessContract(name: string, makeHarness: () => Harness, model: string) {
  describe(`${name} harness contract`, { timeout: 300_000 }, () => {
    const harness = makeHarness()

    function workspace() {
      const cwd = tempDir('conveyor-contract-')
      writeFileSync(join(cwd, 'note.txt'), 'hello-from-file\n')
      return cwd
    }

    it('reads the workspace and returns done', async () => {
      let events = 0
      const output = await harness.runStage({
        prompt: 'Read note.txt in the current directory. Return outcome done and put the exact file content, trimmed, in summary.',
        model,
        effort: 'low',
        cwd: workspace(),
        onEvent: () => events++,
      })
      expect(output.result).toMatchObject({ outcome: 'done', summary: 'hello-from-file' })
      expect(output.usage.inputTokens).toBeGreaterThan(0)
      expect(output.usage.outputTokens).toBeGreaterThan(0)
      expect(events).toBeGreaterThan(0)
    })

    it('returns questions with needs_input', async () => {
      const output = await harness.runStage({
        prompt: 'Do not use any tools. Return outcome needs_input with exactly one question: "Which color?"',
        model,
        effort: 'low',
        cwd: workspace(),
      })
      expect(output.result.outcome).toBe('needs_input')
      expect(output.result.questions).toHaveLength(1)
    })

    it('stops on abort', async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 3_000)
      const started = Date.now()
      const output = await harness.runStage({
        prompt: 'Run the shell command `sleep 120`, then return outcome done.',
        model,
        effort: 'low',
        cwd: workspace(),
        signal: controller.signal,
      })
      expect(output.result.outcome).toBe('failed')
      expect(Date.now() - started).toBeLessThan(30_000)
    })
  })
}
