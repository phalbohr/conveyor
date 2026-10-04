import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { runCli, tempDir } from './helpers.js'

const BOARD_FLAGS = ['--provider', 'github', '--project', 'owner/repo']

describe('conveyor init', () => {
  it('creates settings in the current directory', async () => {
    const result = await runCli(['init', ...BOARD_FLAGS])
    const settings = join(result.context.cwd, '.conveyor')

    expect(result.code).toBe(0)
    const loaded = loadConfig(settings)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
    expect(loaded.config.board).toEqual({ provider: 'github', project: 'owner/repo' })
    for (const stage of loaded.config.stages) expect(existsSync(join(settings, 'stages', `${stage.name}.md`))).toBe(true)
    for (const gate of ['idea-story', 'story-plan', 'merge']) expect(existsSync(join(settings, 'smart', `${gate}.md`))).toBe(true)
    expect(existsSync(join(settings, 'triage.md'))).toBe(true)
    for (const live of ['new', 'attach']) expect(existsSync(join(settings, 'live', `${live}.md`))).toBe(true)
    expect(existsSync(join(settings, 'formats', 'story.md'))).toBe(true)
    expect(readFileSync(join(settings, '.gitignore'), 'utf8')).toContain('local.yaml')
  })

  it('detects the board from the git remote', async () => {
    const result = await runCli(['init'], {
      responses: { 'git remote get-url origin': { code: 0, stdout: 'git@github.com:acme/widgets.git\n' } },
    })
    expect(result.code).toBe(0)
    const loaded = loadConfig(join(result.context.cwd, '.conveyor'))
    expect(loaded.ok && loaded.config.board).toEqual({ provider: 'github', project: 'acme/widgets' })
  })

  it('detects a GitLab board from an HTTPS remote with subgroups', async () => {
    const result = await runCli(['init'], {
      responses: { 'git remote get-url origin': { code: 0, stdout: 'https://gitlab.com/acme/tools/widgets.git\n' } },
    })
    const loaded = loadConfig(join(result.context.cwd, '.conveyor'))
    expect(loaded.ok && loaded.config.board).toEqual({ provider: 'gitlab', project: 'acme/tools/widgets' })
  })

  it('fails without a detectable board in non-interactive mode', async () => {
    const result = await runCli(['init'], { responses: { 'git remote get-url origin': { code: 2 } } })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--provider')
  })

  it('creates settings outside the working directory and links them', async () => {
    const outside = join(tempDir(), 'settings')
    const result = await runCli(['init', '--path', outside, ...BOARD_FLAGS])

    expect(result.code).toBe(0)
    expect(existsSync(join(outside, 'config.yaml'))).toBe(true)
    expect(existsSync(join(result.context.cwd, '.conveyor'))).toBe(false)

    const status = await runCli([], { cwd: result.context.cwd, home: result.context.home })
    expect(status.code).toBe(0)
    expect(status.stdout).toContain(outside)
  })

  it('links the working directory to existing settings', async () => {
    const first = await runCli(['init', ...BOARD_FLAGS])
    const existing = join(first.context.cwd, '.conveyor')
    const result = await runCli(['init', '--use', existing])

    expect(result.code).toBe(0)
    const status = await runCli(['--json'], { cwd: result.context.cwd, home: result.context.home })
    expect(JSON.parse(status.stdout)).toMatchObject({ settings: existing, valid: true })
  })

  it('rejects existing settings without config.yaml', async () => {
    const result = await runCli(['init', '--use', tempDir()])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('config.yaml')
  })

  it('refuses to initialize twice', async () => {
    const first = await runCli(['init', ...BOARD_FLAGS])
    const second = await runCli(['init', ...BOARD_FLAGS], { cwd: first.context.cwd, home: first.context.home })
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('already')
  })

  it('reports missing tools as warnings', async () => {
    const result = await runCli(['init', ...BOARD_FLAGS], {
      responses: { 'gh auth status': { code: 1 }, 'claude --version': { code: 127 } },
    })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('gh')
    expect(result.stderr).toContain('claude')
  })

  it('prints the result as JSON', async () => {
    const result = await runCli(['init', ...BOARD_FLAGS, '--json'], { responses: { 'gh auth status': { code: 1 } } })
    const output = JSON.parse(result.stdout)
    expect(output.settings).toBe(join(result.context.cwd, '.conveyor'))
    expect(output.warnings).toHaveLength(1)
  })
})

describe('conveyor without settings', () => {
  it('asks to run init in non-interactive mode', async () => {
    const result = await runCli([])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('conveyor init')
  })

  it('reports an invalid configuration', async () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.conveyor'))
    writeFileSync(join(cwd, '.conveyor', 'config.yaml'), 'board: {provider: jira, project: x}\n')
    const result = await runCli([], { cwd })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('board.provider')
  })
})
