import { describe, expect, it } from 'vitest'
import { labelsToTask } from '../src/board/board.js'
import { FakeBoard } from '../src/board/fake.js'
import { GitHubBoard } from '../src/board/github.js'
import { boardContract } from './board-contract.js'
import { createRun } from '../src/run.js'

boardContract('fake', () => new FakeBoard('tester'))

const sandbox = process.env.CONVEYOR_GITHUB_SANDBOX
if (sandbox) boardContract('github', () => new GitHubBoard(sandbox, createRun()), { timeout: 120_000 })

describe('labelsToTask', () => {
  it('reads state, owner, and priority', () => {
    expect(labelsToTask(['bug', 'conveyor::review', 'claimed-by::alice', 'priority::2'])).toEqual({
      state: 'review',
      owner: 'alice',
      priority: 2,
    })
  })

  it('ignores unknown states and invalid priorities', () => {
    expect(labelsToTask(['conveyor::shipping', 'priority::high'])).toEqual({})
  })
})
