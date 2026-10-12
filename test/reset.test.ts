import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { resetTask } from '../src/engine/reset.js'
import { manualRelease } from '../src/engine/release.js'
import { findWorkpad, renderWorkpad } from '../src/engine/workpad.js'
import { FakeWorkspaces } from './fakes.js'
import { runCli, tempDir } from './helpers.js'

async function started(board: FakeBoard) {
  const task = await board.createTask('Login', 'story text', { state: 'in-progress' })
  await board.claim(task.id)
  await board.setOwner(task.id, 'me')
  await board.setStage(task.id, 'implement')
  await board.addComment(task.id, renderWorkpad({ attempt: 2, stage: 'implement', form: 'story', lastError: 'tests are red', parts: ['api', 'ui'], part: 0 }, 'plan notes'))
  await board.setPart(task.id, '1/2')
  await board.openPullRequest(task.id, task.title, '')
  return task.id
}

describe('resetTask', () => {
  it('closes the pull request, deletes the branch and workspace, clears the workpad, and returns the task with its form', async () => {
    const board = new FakeBoard('me')
    const workspaces = new FakeWorkspaces()
    const id = await started(board)
    const session = join(tempDir(), 'sessions', `${id}.log`)
    mkdirSync(join(session, '..'))
    writeFileSync(session, 'old stage\n')

    const summary = await resetTask(board, workspaces, id, undefined, session)

    expect(summary).toContain('back in Backlog with form::story')
    expect((await board.pullRequest(id))?.state).toBe('closed')
    expect(workspaces.removed).toContain(id)
    expect(workspaces.deletedBranches).toContain(id)
    expect(existsSync(session)).toBe(false)
    const task = await board.getTask(id)
    expect(task).toMatchObject({ state: 'backlog', form: 'story' })
    expect([task?.owner, task?.stage]).toEqual([undefined, undefined])
    expect((await board.getTask(id))?.labels.some((label) => label.startsWith('part::'))).toBe(false)
    const comments = await board.listComments(id)
    expect(findWorkpad(comments)?.state).toEqual({ attempt: 0 })
    expect(comments.at(-1)?.body).toContain('Reset by @me')
  })

  it('starts again with the chosen form or as a draft', async () => {
    const board = new FakeBoard('me')
    const plan = await started(board)
    await resetTask(board, new FakeWorkspaces(), plan, 'plan')
    expect((await board.getTask(plan))?.form).toBe('plan')

    const draft = await started(board)
    await resetTask(board, new FakeWorkspaces(), draft, 'none')
    expect((await board.getTask(draft))?.form).toBeUndefined()
  })

  it('leaves a task of another member alone', async () => {
    const board = new FakeBoard('me')
    const id = await started(board)
    await board.setOwner(id, 'alice')
    await expect(resetTask(board, new FakeWorkspaces(), id)).rejects.toThrow('claimed by @alice')
  })
})

describe('conveyor reset', () => {
  it('resets a task from the command line with a chosen form', async () => {
    const board = new FakeBoard('me')
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const id = await started(board)

    const result = await runCli(['reset', id, '--form', 'idea'], { cwd: init.context.cwd, home: init.context.home, board })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('back in Backlog with form::idea')
    expect((await board.getTask(id))?.form).toBe('idea')
  })
})

describe('release', () => {
  it('removes the conveyor user from the assignees and keeps a human assignee', async () => {
    const board = new FakeBoard('me')
    const id = await started(board)
    board.assign(id, 'me', 'alice')
    expect(await manualRelease(board, id, false)).toEqual({ ok: true })
    const task = await board.getTask(id)
    expect(task?.assignees).toEqual(['alice'])
    expect(task?.owner).toBeUndefined()
  })
})
