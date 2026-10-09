import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import type { Context } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { Runner, logFile } from '../src/runner.js'
import { tempDir } from './helpers.js'

describe('Runner log', () => {
  it('moves a log over 10 MB to .1, starts a new one, and hides secrets', async () => {
    const settings = tempDir('conveyor-settings-')
    writeFileSync(join(settings, 'config.yaml'), 'board: {provider: github, project: acme/app}\n')
    mkdirSync(join(settings, 'stages'))
    writeFileSync(join(settings, 'stages', 'story.md'), '---\nskills: [missing]\n---\n')
    const loaded = loadConfig(settings)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
    const home = tempDir('conveyor-home-')
    const file = logFile(home, 'acme/app')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'x'.repeat(10 * 1024 * 1024 + 1))
    const context = { cwd: tempDir(), home, stdout: () => undefined, stderr: () => undefined } as unknown as Context

    const started = await new Runner(context, { settings, config: loaded.config, board: new FakeBoard('me'), secrets: () => ['missing'] }).start({ once: true })

    expect(started.ok).toBe(false)
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(statSync(file).size).toBeLessThan(1024)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain('skills not found: [redacted]')
  })

  it('writes notes of the control screen to the log', async () => {
    const home = tempDir('conveyor-home-')
    const settings = tempDir('conveyor-settings-')
    writeFileSync(join(settings, 'config.yaml'), 'board: {provider: github, project: acme/app}\n')
    const loaded = loadConfig(settings)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
    const context = { cwd: tempDir(), home, stdout: () => undefined, stderr: () => undefined } as unknown as Context
    const runner = new Runner(context, { settings, config: loaded.config, board: new FakeBoard('me'), secrets: () => [] })
    runner.note('The session on task 15 ended without a comment.')
    expect(runner.events.at(-1)?.text).toBe('The session on task 15 ended without a comment.')
    expect(readFileSync(logFile(home, 'acme/app'), 'utf8')).toContain('The session on task 15 ended without a comment.')
  })
})
