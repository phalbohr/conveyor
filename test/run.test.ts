import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { checkStages, cleanupWorkspaces } from '../src/commands/run.js'
import { loadConfig } from '../src/config.js'
import { acquireRunLock } from '../src/lock.js'
import { FakeWorkspaces } from './fakes.js'
import { runCli, tempDir } from './helpers.js'

function settings(config: string, stages: Record<string, string> = {}) {
  const dir = tempDir('conveyor-settings-')
  writeFileSync(join(dir, 'config.yaml'), `board: {provider: github, project: acme/app}\n${config}`)
  mkdirSync(join(dir, 'stages'))
  for (const [name, text] of Object.entries(stages)) writeFileSync(join(dir, 'stages', `${name}.md`), text)
  const loaded = loadConfig(dir)
  if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  return { dir, config: loaded.config }
}

describe('checkStages', () => {
  it('accepts stages without problems', () => {
    const { dir, config } = settings('stages:\n  implement: {}\n', { implement: 'Implement it.' })
    expect(checkStages(config, dir, { repo: tempDir(), home: tempDir() })).toEqual([])
  })

  it('reports missing skills, invalid frontmatter, and skills on non-claude stages', () => {
    const { dir, config } = settings('stages:\n  implement: {}\n  review: {harness: codex}\n', {
      story: '---\nskills: grilling\n---\n',
      implement: '---\nskills: [grilling]\n---\nUse grilling.',
      review: '---\nskills: [grilling]\n---\n',
    })
    const problems = checkStages(config, dir, { repo: tempDir(), home: tempDir() })
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toContain('stages/story.md')
    expect(problems.join('\n')).toContain('implement: skills not found: grilling')
    expect(problems.join('\n')).toContain('review')
  })
})

describe('cleanupWorkspaces', () => {
  it('removes workspaces of closed and missing tasks', async () => {
    const board = new FakeBoard('me')
    const open = await board.createTask('Open', 'p', 'in-progress')
    const closed = await board.createTask('Closed', 'p', 'review')
    await board.closeTask(closed.id)
    const workspaces = new FakeWorkspaces()
    for (const id of [open.id, closed.id, '99']) await workspaces.prepare(id)

    await cleanupWorkspaces(board, workspaces, () => undefined)

    expect(workspaces.removed.sort()).toEqual([closed.id, '99'].sort())
  })
})

describe('acquireRunLock', () => {
  it('allows one run per project and takes over a stale lock', () => {
    const home = tempDir()
    const first = acquireRunLock(home, 'acme/app')
    expect(first.ok).toBe(true)
    expect(acquireRunLock(home, 'acme/app')).toMatchObject({ ok: false, pid: process.pid })
    expect(acquireRunLock(home, 'acme/other').ok).toBe(true)
    if (first.ok) first.release()
    expect(acquireRunLock(home, 'acme/app').ok).toBe(true)

    const stale = tempDir()
    mkdirSync(join(stale, '.conveyor', 'run'), { recursive: true })
    writeFileSync(join(stale, '.conveyor', 'run', 'acme-app.pid'), '999999')
    expect(acquireRunLock(stale, 'acme/app').ok).toBe(true)
  })
})

describe('conveyor run and release', () => {
  it('stops before the board when a stage has problems', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    writeFileSync(join(init.context.cwd, '.conveyor', 'stages', 'implement.md'), '---\nskills: [nope]\n---\n')
    const result = await runCli(['run', '--once'], { cwd: init.context.cwd, home: init.context.home })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('skills not found: nope')
    expect(result.calls.filter((call) => call.startsWith('gh '))).toEqual([])
  })

  it('requires settings', async () => {
    expect((await runCli(['run'])).stderr).toContain('conveyor init')
    expect((await runCli(['release', '3'])).stderr).toContain('conveyor init')
  })
})
