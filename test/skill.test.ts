import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, tempDir } from './helpers.js'

describe('conveyor skill install', () => {
  it('installs the skill for Claude Code and for .agents readers in the home directory', async () => {
    const result = await runCli(['skill', 'install'])
    expect(result.code).toBe(0)
    for (const dir of ['.claude', '.agents']) {
      const skill = join(result.context.home, dir, 'skills', 'conveyor-help')
      expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toContain('name: conveyor-help')
      expect(existsSync(join(skill, 'workflow.md'))).toBe(true)
    }
  })

  it('installs into the repository with --project', async () => {
    const result = await runCli(['skill', 'install', '--project', '--json'])
    expect(JSON.parse(result.stdout).installed).toEqual([
      join(result.context.cwd, '.claude', 'skills', 'conveyor-help'),
      join(result.context.cwd, '.agents', 'skills', 'conveyor-help'),
    ])
  })

  it('replaces an older copy and leaves a symlink target untouched', async () => {
    const home = tempDir('conveyor-home-')
    const elsewhere = tempDir('conveyor-elsewhere-')
    writeFileSync(join(elsewhere, 'SKILL.md'), 'user file')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync(elsewhere, join(home, '.claude', 'skills', 'conveyor-help'))
    await runCli(['skill', 'install'], { home })
    expect(readFileSync(join(elsewhere, 'SKILL.md'), 'utf8')).toBe('user file')
    expect(readFileSync(join(home, '.claude', 'skills', 'conveyor-help', 'SKILL.md'), 'utf8')).toContain('name: conveyor-help')
  })
})
