import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { restartTask } from '../src/engine/restart.js'
import { findWorkpad, renderWorkpad, type WorkpadState } from '../src/engine/workpad.js'
import { FakeWorkspaces } from './fakes.js'

const STAGES = ['story', 'plan', 'implement', 'review', 'merge']

async function started(board: FakeBoard, state: WorkpadState, taskState: 'in-progress' | 'needs-input' = 'needs-input') {
  const task = await board.createTask('Login', 'story text', { state: taskState })
  await board.setOwner(task.id, 'me')
  await board.setStage(task.id, state.stage ?? 'implement')
  await board.addComment(task.id, renderWorkpad(state, 'plan notes'))
  return task.id
}

const pad = async (board: FakeBoard, id: string) => findWorkpad(await board.listComments(id))

describe('restartTask', () => {
  it('drops what the last run of the stage left and starts the same stage again', async () => {
    const board = new FakeBoard('me')
    const workspaces = new FakeWorkspaces()
    const id = await started(board, { attempt: 3, stage: 'review', stageBase: 'abc', runs: { review: 4 }, lastResult: 'done: ok', lastError: 'red', waiting: { kind: 'error', stage: 'review', since: '2026-10-22T10:00:00.000Z' } })

    const summary = await restartTask(board, workspaces, id, 'stage', STAGES)

    expect(summary).toContain('Stage review of #1 restarted by @me')
    expect(workspaces.rewinds).toEqual([{ taskId: id, to: 'abc' }])
    expect((await pad(board, id))?.state).toEqual({ attempt: 0, stage: 'review', stageBase: 'abc' })
    expect((await pad(board, id))?.text).toBe('plan notes')
    expect(await board.getTask(id)).toMatchObject({ state: 'in-progress', stage: 'review' })
  })

  it('rewinds the branch to the start of the current part and starts the part at its first stage', async () => {
    const board = new FakeBoard('me')
    const workspaces = new FakeWorkspaces()
    const id = await started(board, { attempt: 1, stage: 'review', parts: ['api', 'ui'], part: 1, partBase: 'p1', stageBase: 's5', review: 'fix it', reviewMode: 'fix' }, 'in-progress')

    const summary = await restartTask(board, workspaces, id, 'part', STAGES)

    expect(summary).toContain('Part 2 of 2 of #1 restarted by @me')
    expect(workspaces.rewinds).toEqual([{ taskId: id, to: 'p1' }])
    expect((await pad(board, id))?.state).toEqual({ attempt: 0, stage: 'implement', parts: ['api', 'ui'], part: 1, partBase: 'p1' })
    expect(await board.getTask(id)).toMatchObject({ state: 'in-progress', stage: 'implement' })
  })

  it('says that commits stay when the stage started before marks were recorded', async () => {
    const board = new FakeBoard('me')
    const workspaces = new FakeWorkspaces()
    const id = await started(board, { attempt: 0, stage: 'implement' }, 'in-progress')
    expect(await restartTask(board, workspaces, id, 'stage', STAGES)).toContain('drops the changes it did not commit; its commits stay')
    expect(workspaces.rewinds).toEqual([{ taskId: id }])
  })

  it('refuses a part without a recorded start or with a merged repository', async () => {
    const board = new FakeBoard('me')
    const workspaces = new FakeWorkspaces()
    const old = await started(board, { attempt: 0, stage: 'review', parts: ['api', 'ui'], part: 0 }, 'in-progress')
    await expect(restartTask(board, workspaces, old, 'part', STAGES)).rejects.toThrow('no start of part 1 is recorded')
    const merged = await started(board, { attempt: 0, stage: 'merge', parts: ['api', 'ui'], part: 1, partBase: 'p1', repos: { frontend: { number: '3', url: 'u', merged: true } } }, 'in-progress')
    await expect(restartTask(board, workspaces, merged, 'part', STAGES)).rejects.toThrow('is merged already')
    expect(workspaces.rewinds).toEqual([])
  })

  it('refuses a task without a stage, without parts, or of another owner', async () => {
    const board = new FakeBoard('me')
    const workspaces = new FakeWorkspaces()
    const landing = await started(board, { attempt: 0, stage: 'land' }, 'in-progress')
    await expect(restartTask(board, workspaces, landing, 'stage', STAGES)).rejects.toThrow('runs no stage now; it waits to merge')
    await expect(restartTask(board, workspaces, landing, 'part', STAGES)).rejects.toThrow('has no parts')
    await board.setOwner(landing, 'alice')
    await expect(restartTask(board, workspaces, landing, 'stage', STAGES)).rejects.toThrow('claimed by @alice')
    expect(workspaces.rewinds).toEqual([])
  })
})
