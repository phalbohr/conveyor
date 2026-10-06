import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { SettingsDocument } from '../src/settings-editor.js'
import { SettingsScreen } from '../src/ui/settings-screen.js'
import { runCli, tempDir } from './helpers.js'

const ENTER = '\r'
const DOWN = '\u001B[B'
const RIGHT = '\u001B[C'
const LEFT = '\u001B[D'
const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5_000 })
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

function setup() {
  const dir = tempDir('conveyor-settings-')
  writeFileSync(join(dir, 'config.yaml'), 'board:\n  provider: github\n  project: acme/app\ntransitions:\n  merge: human\nstages:\n  implement: {}\n  merge: {}\n')
  writeFileSync(join(dir, 'local.yaml'), 'limits:\n  running: 3\n')
  const rendered = render(<SettingsScreen doc={new SettingsDocument(dir)} />)
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      await settle()
      rendered.stdin.write(key)
    }
    await settle()
  }
  return { dir, rendered, press }
}

describe('SettingsScreen', () => {
  it('changes the merge mode and saves it', async () => {
    const { dir, rendered, press } = setup()
    await until(() => expect(rendered.lastFrame()).toContain('Merge mode'))

    await press(DOWN, DOWN, DOWN, ENTER)
    await until(() => expect(rendered.lastFrame()).toContain('smart'))
    await press(DOWN, ENTER)
    await until(() => expect(rendered.lastFrame()).toContain('unsaved changes'))
    await press('s')

    await until(() => expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toContain('merge: ai'))
    expect(rendered.lastFrame()).toContain('Saved.')
  })

  it('cycles the options of a field with the arrow keys', async () => {
    const { dir, rendered, press } = setup()
    await until(() => expect(rendered.lastFrame()).toContain('Merge mode'))

    await press(DOWN, DOWN, DOWN, RIGHT)
    await until(() => expect(rendered.lastFrame()).toMatch(/Merge mode\s+ai/))
    await press(RIGHT, RIGHT)
    await until(() => expect(rendered.lastFrame()).toMatch(/Merge mode\s+human/))
    await press(LEFT)
    await until(() => expect(rendered.lastFrame()).toMatch(/Merge mode\s+smart/))
    await press('s')

    await until(() => expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toContain('merge: smart'))
  })

  it('cycles through inherit for stage values', async () => {
    const { dir, rendered, press } = setup()
    const row = new SettingsDocument(dir).fields().findIndex((field) => field.key === 'stages.implement.effort')
    await until(() => expect(rendered.lastFrame()).toContain('Merge mode'))
    await press(...Array.from({ length: row }, () => DOWN), LEFT)
    await until(() => expect(rendered.lastFrame()).toMatch(/implement: effort\s+max/))
    await press(RIGHT)
    await until(() => expect(rendered.lastFrame()).toMatch(/implement: effort\s+\(inherit\)/))
  })

  it('adds a stage before merge', async () => {
    const { dir, rendered, press } = setup()
    await until(() => expect(rendered.lastFrame()).toContain('Merge mode'))

    await press('a')
    await until(() => expect(rendered.lastFrame()).toContain('New stage name'))
    await press('polish', ENTER)
    await until(() => expect(rendered.lastFrame()).toContain('Where does polish run?'))
    await press(ENTER)
    await until(() => expect(rendered.lastFrame()).toContain('unsaved changes'))
    await press('s')

    await until(() => expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toContain('polish: {}\n  merge: {}'))
  })

  it('asks before quitting with unsaved changes', async () => {
    const { rendered, press } = setup()
    await until(() => expect(rendered.lastFrame()).toContain('Merge mode'))
    await press('a')
    await until(() => expect(rendered.lastFrame()).toContain('New stage name'))
    await press('polish', ENTER)
    await until(() => expect(rendered.lastFrame()).toContain('Where does polish run?'))
    await press(ENTER)
    await until(() => expect(rendered.lastFrame()).toContain('unsaved changes'))
    await press('q')
    await until(() => expect(rendered.lastFrame()).toContain('Unsaved changes'))
  })

  it('shows validation errors instead of saving', async () => {
    const { dir, rendered, press } = setup()
    await until(() => expect(rendered.lastFrame()).toContain('Merge mode'))
    const runningRow = new SettingsDocument(dir).fields().findIndex((field) => field.key === 'limits.running')
    await press(...Array.from({ length: runningRow }, () => DOWN), ENTER)
    await until(() => expect(rendered.lastFrame()).toContain('Tasks running at once'))
    await press('\u007F', '0', ENTER)
    await until(() => expect(rendered.lastFrame()).toContain('unsaved changes'))
    await press('s')
    await until(() => expect(rendered.lastFrame()).toContain('limits.running'))
    expect(readFileSync(join(dir, 'local.yaml'), 'utf8')).toContain('running: 3')
  })
})

describe('conveyor settings', () => {
  it('needs a terminal', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const result = await runCli(['settings'], { cwd: init.context.cwd, home: init.context.home })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('needs a terminal')
  })
})
