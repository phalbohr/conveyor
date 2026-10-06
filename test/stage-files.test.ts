import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { manualRelease } from '../src/engine/release.js'
import { renderWorkpad } from '../src/engine/workpad.js'
import { parseStageFile, renderInstructions } from '../src/engine/stage-file.js'
import { resolveSkills } from '../src/skills.js'
import { UsageLedger } from '../src/usage.js'
import { tempDir } from './helpers.js'

describe('parseStageFile', () => {
  it('reads skills from the frontmatter and returns the body', () => {
    expect(parseStageFile('---\nskills: [brainstorming, superpowers:grilling]\n---\nWrite the story.\n')).toEqual({
      ok: true,
      skills: ['brainstorming', 'superpowers:grilling'],
      template: 'Write the story.\n',
    })
  })

  it('accepts a file without frontmatter', () => {
    expect(parseStageFile('Just text.\n')).toEqual({ ok: true, skills: [], template: 'Just text.\n' })
  })

  it('rejects invalid frontmatter', () => {
    expect(parseStageFile('---\nskills: grilling\n---\nText\n')).toMatchObject({ ok: false, error: expect.stringContaining('skills') })
    expect(parseStageFile('---\ntools: [x]\n---\nText\n')).toMatchObject({ ok: false, error: expect.stringContaining('tools') })
  })
})

describe('renderInstructions', () => {
  const variables = { issue: { id: '7', title: 'Login' }, stage: 'plan', attempt: 0, artifacts: {}, review: '' }

  it('renders known variables', () => {
    expect(renderInstructions('Plan #{{ issue.id }} {{ issue.title }} in {{ stage }}{% if artifacts.story %} with story{% endif %}', variables)).toEqual({
      ok: true,
      text: 'Plan #7 Login in plan',
    })
  })

  it('fails on an unknown variable', () => {
    expect(renderInstructions('{{ issue.owner }}', variables)).toMatchObject({ ok: false, error: expect.stringContaining('issue.owner') })
  })
})

describe('resolveSkills', () => {
  function layout() {
    const repo = tempDir('conveyor-repo-')
    const home = tempDir('conveyor-home-')
    const skill = (base: string, name: string) => {
      mkdirSync(join(base, name), { recursive: true })
      writeFileSync(join(base, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
      return join(base, name)
    }
    skill(join(repo, '.claude', 'skills'), 'shared')
    skill(join(home, '.claude', 'skills'), 'shared')
    const linkedTarget = skill(tempDir(), 'linked')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync(linkedTarget, join(home, '.claude', 'skills', 'linked'))
    const installPath = join(home, '.claude', 'plugins', 'cache', 'market', 'superpowers', '1.0.0')
    skill(join(installPath, 'skills'), 'grilling')
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'superpowers@market': [{ scope: 'user', installPath }] } }),
    )
    return { repo, home, installPath }
  }

  it('looks in the project, then personal skills, then plugins', () => {
    const { repo, home, installPath } = layout()
    const result = resolveSkills(['shared', 'linked', 'superpowers:grilling'], { repo, home })
    expect(result.missing).toEqual([])
    expect(result.skills).toEqual([
      { name: 'shared', source: 'project', dir: join(repo, '.claude', 'skills', 'shared') },
      { name: 'linked', source: 'personal', dir: join(home, '.claude', 'skills', 'linked') },
      { name: 'superpowers:grilling', source: 'plugin', plugin: 'superpowers', skill: 'grilling', dir: join(installPath, 'skills', 'grilling') },
    ])
  })

  it('reports missing skills', () => {
    const { repo, home } = layout()
    expect(resolveSkills(['nope', 'other:thing'], { repo, home }).missing).toEqual(['nope', 'other:thing'])
  })
})

describe('UsageLedger', () => {
  it('sums tokens per local day and persists them', () => {
    const file = join(tempDir(), 'usage.json')
    const ledger = new UsageLedger(file)
    ledger.add(100, new Date('2026-10-05T10:00:00'))
    ledger.add(50, new Date('2026-10-05T18:00:00'))
    expect(new UsageLedger(file).today(new Date('2026-10-05T23:00:00'))).toBe(150)
    expect(new UsageLedger(file).today(new Date('2026-10-06T08:00:00'))).toBe(0)
  })
})

describe('manualRelease', () => {
  async function claimed(owner: string, state: { private?: boolean } = {}) {
    const board = new FakeBoard('me')
    const task = await board.createTask('Task', 'p', 'in-progress')
    await board.claim(task.id)
    await board.setOwner(task.id, owner)
    await board.addComment(task.id, renderWorkpad({ attempt: 0, ...state }, ''))
    return { board, id: task.id }
  }

  it('releases the claim and keeps the state', async () => {
    const { board, id } = await claimed('alice')
    expect(await manualRelease(board, id, false)).toEqual({ ok: true })
    expect(await board.getTask(id)).toMatchObject({ state: 'in-progress' })
    expect((await board.getTask(id))?.owner).toBeUndefined()
    expect(await board.claim(id)).toBe(true)
    expect((await board.listComments(id)).at(-1)?.body).toContain('Released manually by @me')
  })

  it('requires force for a private task of another member', async () => {
    const { board, id } = await claimed('alice', { private: true })
    expect(await manualRelease(board, id, false)).toMatchObject({ ok: false, error: expect.stringContaining('--force') })
    expect(await manualRelease(board, id, true)).toEqual({ ok: true })
  })

  it('releases my own private task without force', async () => {
    const { board, id } = await claimed('me', { private: true })
    expect(await manualRelease(board, id, false)).toEqual({ ok: true })
  })

  it('removes an orphaned lock of a task without an owner', async () => {
    const board = new FakeBoard('me')
    const task = await board.createTask('Task', 'p', 'plan')
    await board.claim(task.id)
    expect(await manualRelease(board, task.id, false)).toEqual({ ok: true })
    expect(await board.claim(task.id)).toBe(true)
  })
})
