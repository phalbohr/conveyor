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

  it('keeps the parts of the plan when the task starts again from its plan', async () => {
    const board = new FakeBoard('me')
    const pad = async (id: string, part: number) => {
      const comment = findWorkpad(await board.listComments(id))
      if (comment) await board.updateComment(comment.id, renderWorkpad({ attempt: 0, stage: 'implement', parts: ['api', 'ui', 'docs'], part }, ''))
    }
    const together = await started(board)
    await pad(together, 2)
    const summary = await resetTask(board, new FakeWorkspaces(), together, 'plan', undefined, 'together')
    expect(findWorkpad(await board.listComments(together))?.state).toEqual({ attempt: 0, parts: ['api', 'ui', 'docs'], part: 0 })
    expect(board.labelsOf(together)).toContain('part::1/3')
    expect(summary).toContain('The 3 parts of the plan stay; the work starts again at part 1.')
    expect(summary).not.toContain('stay merged')

    const separate = await started(board)
    await pad(separate, 1)
    expect(await resetTask(board, new FakeWorkspaces(), separate, 'plan')).toContain('Parts 1–1 stay merged in the base branch. The 3 parts of the plan stay; the work starts again at part 2.')
    expect(findWorkpad(await board.listComments(separate))?.state.part).toBe(1)

    const story = await started(board)
    await resetTask(board, new FakeWorkspaces(), story, 'story')
    expect(findWorkpad(await board.listComments(story))?.state).toEqual({ attempt: 0 })
  })

  it('closes or deletes the issue after the reset, and closes it when it may not be deleted', async () => {
    const board = new FakeBoard('me')
    const closed = await started(board)
    expect(await resetTask(board, new FakeWorkspaces(), closed, 'none', undefined, 'separate', 'close')).toContain('Closed the issue.')
    expect((await board.getTask(closed))?.closed).toBe(true)

    const deleted = await started(board)
    expect(await resetTask(board, new FakeWorkspaces(), deleted, 'none', undefined, 'separate', 'delete')).toMatch(/^Deleted #\d+ by @me: .*deleted the issue\./)
    expect(await board.getTask(deleted)).toBeUndefined()

    board.deletable = false
    const kept = await started(board)
    expect(await resetTask(board, new FakeWorkspaces(), kept, 'none', undefined, 'separate', 'delete')).toContain('The issue was not deleted (403 Forbidden: only owners delete issues), so it is closed instead.')
    expect((await board.getTask(kept))?.closed).toBe(true)
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

  it('closes the issue with --close and refuses --close together with --form', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const board = new FakeBoard('me')
    const id = await started(board)
    const result = await runCli(['reset', id, '--close'], { cwd: init.context.cwd, home: init.context.home, board })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Closed the issue.')
    expect((await board.getTask(id))?.closed).toBe(true)
    const both = await runCli(['reset', id, '--close', '--form', 'idea'], { cwd: init.context.cwd, home: init.context.home, board })
    expect(both.code).not.toBe(0)
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
