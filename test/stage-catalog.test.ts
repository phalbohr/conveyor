import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { SettingsDocument } from '../src/settings-editor.js'
import { stageCatalog, stageStub, undescribedStages } from '../src/stage-catalog.js'
import { runCli, tempDir } from './helpers.js'

function settings(stages: string, files: Record<string, string>) {
  const dir = tempDir('conveyor-settings-')
  writeFileSync(join(dir, 'config.yaml'), `board: {provider: github, project: acme/app}\nstages:\n${stages}`)
  mkdirSync(join(dir, 'stages'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'stages', `${name}.md`), text)
  const loaded = loadConfig(dir)
  if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  return { dir, config: loaded.config }
}

describe('stageCatalog', () => {
  it('lists configured stages and stage files with enabled and described flags', () => {
    const { dir, config } = settings('  implement: {}\n  polish: {}\n  review: {}\n', {
      story: 'Write the story.',
      plan: 'Write the plan.',
      implement: '---\nskills: [tdd]\n---\nImplement the plan.',
      polish: stageStub('polish'),
      review: '---\nskills: [x]\n---\n   \n',
      merge: 'Prepare the merge.',
      'deploy-notes': 'Write deploy notes.',
    })

    expect(stageCatalog(dir, config)).toEqual([
      { name: 'story', enabled: true, reserved: true, described: true },
      { name: 'plan', enabled: true, reserved: true, described: true },
      { name: 'implement', enabled: true, reserved: false, described: true },
      { name: 'polish', enabled: true, reserved: false, described: false },
      { name: 'review', enabled: true, reserved: false, described: false },
      { name: 'merge', enabled: true, reserved: true, described: true },
      { name: 'deploy-notes', enabled: false, reserved: false, described: true },
    ])
    expect(undescribedStages(dir, config)).toEqual(['polish', 'review'])
  })

  it('treats a missing file as undescribed', () => {
    const { dir, config } = settings('  implement: {}\n', {})
    expect(undescribedStages(dir, config)).toEqual(['story', 'plan', 'implement', 'merge'])
  })
})

describe('stage files when stages change', () => {
  it('creates a stub for a new stage on save and keeps existing files', () => {
    const { dir } = settings('  implement: {}\n', { implement: 'Implement it.' })
    const doc = new SettingsDocument(dir)
    doc.addStage('polish', 'before-merge')
    expect(doc.save()).toEqual({ ok: true, created: ['stages/polish.md'] })
    expect(readFileSync(join(dir, 'stages', 'polish.md'), 'utf8')).toBe(stageStub('polish'))
    expect(readFileSync(join(dir, 'stages', 'implement.md'), 'utf8')).toBe('Implement it.')
  })

  it('toggles stage files on and off in the editor model', () => {
    const { dir } = settings('  implement: {}\n', { implement: 'Implement it.', 'deploy-notes': 'Write deploy notes.' })
    const doc = new SettingsDocument(dir)
    const toggle = (name: string) => doc.fields().find((field) => field.key === `stage-files.${name}`)
    expect(toggle('deploy-notes')).toMatchObject({ group: 'Stage files', value: 'off' })
    doc.set('stage-files.deploy-notes', 'on')
    expect(doc.stageNames()).toContain('deploy-notes')
    doc.set('stage-files.implement', 'off')
    expect(doc.stageNames()).not.toContain('implement')
    expect(existsSync(join(dir, 'stages', 'implement.md'))).toBe(true)
    expect(() => doc.set('stage-files.plan', 'off')).toThrow('reserved')
  })

  it('names the missing description in the toggle help', () => {
    const { dir } = settings('  polish: {}\n', { polish: stageStub('polish') })
    const field = new SettingsDocument(dir).fields().find((candidate) => candidate.key === 'stage-files.polish')
    expect(field?.help).toContain('no description')
  })
})

describe('notices about undescribed stages', () => {
  it('conveyor config stage add names the file to fill in', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const result = await runCli(['config', 'stage', 'add', 'polish'], { cwd: init.context.cwd, home: init.context.home })
    expect(result.stdout).toContain('stages/polish.md')
    expect(readFileSync(join(init.context.cwd, '.conveyor', 'stages', 'polish.md'), 'utf8')).toBe(stageStub('polish'))
  })

  it('conveyor run and the status warn about stages without a description', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const context = { cwd: init.context.cwd, home: init.context.home, board: new FakeBoard('me') }
    await runCli(['config', 'stage', 'add', 'polish'], context)

    const run = await runCli(['run', '--once'], context)
    expect(run.stderr).toContain('polish')
    expect(run.stderr).toContain('no description')

    const status = await runCli([], context)
    expect(status.stdout).toContain('Stage polish has no description')
  })
})
