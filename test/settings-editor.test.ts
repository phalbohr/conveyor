import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from './helpers.js'
import { SettingsDocument } from '../src/settings-editor.js'
import { tempDir } from './helpers.js'

function settings(config: string, local = 'limits:\n  running: 3\n') {
  const dir = tempDir('conveyor-settings-')
  writeFileSync(join(dir, 'config.yaml'), config)
  writeFileSync(join(dir, 'local.yaml'), local)
  return dir
}

const CONFIG = `board:
  provider: github
  project: acme/app
pickup_from: plan
transitions:
  idea_to_story: interactive
  story_to_plan: interactive
  merge: human
stages:
  plan: {model: opus, effort: high}
  implement: {}
  review: {model: opus}
  merge: {model: haiku}
`

describe('SettingsDocument', () => {
  it('lists team, stage, and personal fields with current values', () => {
    const doc = new SettingsDocument(settings(CONFIG))
    const fields = doc.fields()
    expect(fields.find((f) => f.key === 'pickup_from')).toMatchObject({ group: 'Team', kind: 'select', value: 'plan', options: ['idea', 'story', 'plan'] })
    expect(fields.find((f) => f.key === 'stages.review.model')).toMatchObject({ group: 'Stages', value: 'opus' })
    expect(fields.find((f) => f.key === 'stages.implement.model')).toMatchObject({ value: '' })
    expect(fields.find((f) => f.key === 'limits.running')).toMatchObject({ group: 'Personal', kind: 'number', value: '3' })
    expect(fields.every((f) => f.help.length > 0)).toBe(true)
    expect(fields.find((f) => f.key === 'stages.implement.harness')?.options).toEqual(['claude', 'codex', 'opencode', 'kilocode', 'pi', 'openhands', 'agent-zero'])
  })

  it('changes values, keeps formatting, validates, and saves', () => {
    const dir = settings(CONFIG)
    const doc = new SettingsDocument(dir)
    doc.set('transitions.merge', 'smart')
    doc.set('stages.implement.model', 'sonnet')
    doc.set('stages.review.model', '')
    doc.set('limits.awaiting_me', '7')

    expect(doc.save()).toEqual({ ok: true })
    const config = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(config).toContain('merge: smart')
    expect(config).toContain('plan: {model: opus, effort: high}')
    expect(config).toContain('implement: {model: sonnet}')
    expect(config).toContain('review: {}')
    expect(readFileSync(join(dir, 'local.yaml'), 'utf8')).toContain('awaiting_me: 7')
  })

  it('refuses to save an invalid configuration and keeps the files', () => {
    const dir = settings(CONFIG)
    const doc = new SettingsDocument(dir)
    doc.set('limits.running', '0')
    const result = doc.save()
    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining('limits.running')] })
    expect(readFileSync(join(dir, 'local.yaml'), 'utf8')).toContain('running: 3')
  })

  it('adds a stage before merge and a post-merge stage with a condition', () => {
    const dir = settings(CONFIG)
    const doc = new SettingsDocument(dir)
    doc.addStage('polish', 'before-merge')
    doc.addStage('fix-ci', 'after-merge', 'failure')
    expect(doc.save()).toEqual({ ok: true, created: ['stages/polish.md', 'stages/fix-ci.md'] })
    expect(doc.stageNames()).toEqual(['plan', 'implement', 'review', 'polish', 'merge', 'fix-ci'])
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toContain('fix-ci: {when: failure}')
  })

  it('adds merge explicitly before the first post-merge stage', () => {
    const doc = new SettingsDocument(settings('board: {provider: github, project: acme/app}\nstages:\n  implement: {}\n'))
    doc.addStage('verify', 'after-merge', 'success')
    expect(doc.stageNames()).toEqual(['implement', 'merge', 'verify'])
    expect(doc.validate()).toEqual({ ok: true })
  })

  it('removes and moves custom stages but protects reserved ones', () => {
    const doc = new SettingsDocument(settings(CONFIG))
    expect(() => doc.removeStage('plan')).toThrow('reserved')
    doc.moveStage('review', -1)
    expect(doc.stageNames()).toEqual(['plan', 'review', 'implement', 'merge'])
    doc.removeStage('implement')
    expect(doc.stageNames()).toEqual(['plan', 'review', 'merge'])
  })

  it('rejects a duplicate or invalid stage name', () => {
    const doc = new SettingsDocument(settings(CONFIG))
    expect(() => doc.addStage('review', 'before-merge')).toThrow('exists')
    expect(() => doc.addStage('Bad Name', 'before-merge')).toThrow('lowercase')
  })

  it('changes only the edited line of a config created by init', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const dir = join(init.context.cwd, '.conveyor')
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8').split('\n')
    const doc = new SettingsDocument(dir)
    doc.set('stages.implement.model', 'sonnet')
    expect(doc.save()).toEqual({ ok: true })
    const after = readFileSync(join(dir, 'config.yaml'), 'utf8').split('\n')
    const changed = after.filter((line, index) => line !== before[index])
    expect(changed).toEqual(['  implement: {model: sonnet}'])
  })

  it('offers the models and efforts of the stage harness', () => {
    const catalogs = {
      codex: { models: [{ id: 'gpt-6-luna', efforts: ['low', 'high'] }, { id: 'gpt-6-sol', efforts: ['low', 'ultra'] }], fetchedAt: '' },
      claude: { models: [{ id: 'opus' }, { id: 'sonnet' }], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], fetchedAt: '' },
    }
    const dir = settings(`board: {provider: github, project: acme/app}\nstages:\n  implement: {harness: codex, model: gpt-6-sol}\n  review: {model: claude-opus-5}\n  polish: {harness: openhands}\n`)
    const fields = new SettingsDocument(dir, { catalogs }).fields()
    const field = (key: string) => fields.find((candidate) => candidate.key === key)

    expect(field('stages.implement.model')).toMatchObject({ kind: 'select', options: ['gpt-6-luna', 'gpt-6-sol'], other: true, value: 'gpt-6-sol' })
    expect(field('stages.implement.effort')?.options).toEqual(['low', 'ultra'])
    expect(field('stages.review.model')).toMatchObject({ options: ['claude-opus-5', 'opus', 'sonnet'], value: 'claude-opus-5' })
    expect(field('stages.polish.model')).toMatchObject({ kind: 'text', help: expect.stringContaining('any name openhands accepts') })
    expect(field('stages.polish.effort')?.kind).toBe('text')
  })

  it('reports unsaved changes', () => {
    const doc = new SettingsDocument(settings(CONFIG))
    expect(doc.dirty()).toBe(false)
    doc.set('pickup_from', 'story')
    expect(doc.dirty()).toBe(true)
  })
})
