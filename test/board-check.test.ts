import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { boardCheckLines, checkBoard, needsAttention } from '../src/board-check.js'
import { loadConfig } from '../src/config.js'
import { runCli, tempDir } from './helpers.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function config() {
  const dir = tempDir('conveyor-settings-')
  writeFileSync(join(dir, 'config.yaml'), 'board: {provider: github, project: acme/app, github_project: 1}\nstages:\n  implement: {}\n  polish: {}\n  merge: {}\n')
  const loaded = loadConfig(dir)
  if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
  return loaded.config
}

describe('checkBoard', () => {
  it('lists missing labels and changes nothing', async () => {
    const board = new FakeBoard('me')
    const check = await checkBoard(board, config())
    expect(check.missing).toEqual(expect.arrayContaining(['conveyor::backlog', 'form::idea', 'stage::polish']))
    expect(needsAttention(check)).toBe(true)
    expect(board.labels.size).toBe(0)
  })

  it('names labels this version does not use and the open tasks that carry them', async () => {
    const board = new FakeBoard('me')
    await board.prepare(['story', 'plan', 'implement', 'polish', 'merge'])
    const task = await board.createTask('Old style', 'text')
    board.addLabel(task.id, 'conveyor::plan')
    board.labels.add('conveyor::ready')
    const check = await checkBoard(board, config())
    expect(check.missing).toEqual([])
    expect(check.unused).toEqual(['conveyor::plan', 'conveyor::ready'])
    expect(check.outdated).toEqual([{ id: task.id, title: 'Old style', labels: ['conveyor::plan'] }])
    expect(boardCheckLines(check).join('\n')).toContain('#1 Old style has labels this version does not use: conveyor::plan; relabel it by hand')
    expect(board.labelsOf(task.id)).toContain('conveyor::plan')
  })

  it('reports a missing Conveyor field and missing options without changing the field', async () => {
    const board = new FakeBoard('me')
    await board.prepare(['story', 'plan', 'implement', 'polish', 'merge'])
    const inspect = board.inspect.bind(board)
    board.inspect = async () => ({ ...(await inspect()), field: { options: ['backlog', 'in-progress', 'done'] } })
    const check = await checkBoard(board, config())
    expect(check.field).toEqual({ missingOptions: ['needs-input', 'queued', 'review', 'rework'] })
    expect(boardCheckLines(check).join('\n')).toContain('conveyor board update adds them and keeps the existing options and card values')
    board.inspect = async () => ({ ...(await inspect()), field: 'missing' })
    expect((await checkBoard(board, config())).field).toBe('missing')
  })

  it('is quiet when the board has everything', async () => {
    const board = new FakeBoard('me')
    await board.prepare(['story', 'plan', 'implement', 'polish', 'merge'])
    expect(needsAttention(await checkBoard(board, config()))).toBe(false)
  })
})

describe('GitHub project', () => {
  function settingsDir() {
    const dir = tempDir('conveyor-settings-')
    writeFileSync(join(dir, 'config.yaml'), 'board: {provider: github, project: acme/app}\n')
    return dir
  }

  it('reports a repository without a project and a linked project that is not set', async () => {
    const dir = settingsDir()
    const loaded = loadConfig(dir)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
    const board = new FakeBoard('me')
    expect(boardCheckLines(await checkBoard(board, loaded.config))[0]).toContain('The repository has no GitHub project')
    board.projects.push({ number: 2, title: 'Tic board', url: 'https://example.test/projects/2' })
    const check = await checkBoard(board, loaded.config)
    expect(needsAttention(check)).toBe(true)
    expect(boardCheckLines(check)[0]).toContain('linked to GitHub project 2 (Tic board), but board.github_project is not set')
  })

  it('board update uses the linked project, or creates and links one', async () => {
    const linked = new FakeBoard('me')
    linked.projects.push({ number: 2, title: 'Tic board', url: 'https://example.test/projects/2' })
    const one = await runCli(['init', '--provider', 'github', '--project', 'acme/app'], { board: linked })
    expect(one.stdout).toContain('Uses the linked GitHub project 2')
    expect(readFileSync(join(one.context.cwd, '.conveyor', 'config.yaml'), 'utf8')).toContain('github_project: 2')
    expect(linked.createdProjects).toEqual([])

    const empty = new FakeBoard('me')
    const created = await runCli(['init', '--provider', 'github', '--project', 'acme/app'], { board: empty })
    expect(created.stdout).toContain('Created and linked the GitHub project 100')
    expect(empty.createdProjects).toEqual(['app conveyor'])
  })

  it('leaves the choice to the user when several projects are linked', async () => {
    const board = new FakeBoard('me')
    board.projects.push({ number: 2, title: 'A', url: 'u' }, { number: 3, title: 'B', url: 'u' })
    const result = await runCli(['init', '--provider', 'github', '--project', 'acme/app'], { board })
    expect(result.stderr).toContain('several GitHub projects (2 A, 3 B)')
    expect(readFileSync(join(result.context.cwd, '.conveyor', 'config.yaml'), 'utf8')).not.toContain('github_project')
  })
})

describe('conveyor board', () => {
  it('check reports and update adds only what is missing', async () => {
    const board = new FakeBoard('me')
    board.labels.add('conveyor::ready')
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'], { board: new FakeBoard('me') })
    const paths = { cwd: init.context.cwd, home: init.context.home, board }
    const check = await runCli(['board', 'check'], paths)
    expect(check.stdout).toContain('Missing labels this version uses')
    expect(board.labels.has('conveyor::backlog')).toBe(false)
    const update = await runCli(['board', 'update'], paths)
    expect(update.stdout).toContain('Added: ')
    expect(board.labels.has('conveyor::backlog')).toBe(true)
    expect(board.labels.has('conveyor::ready')).toBe(true)
    expect(update.stdout).toContain('conveyor::ready')
  })
})
