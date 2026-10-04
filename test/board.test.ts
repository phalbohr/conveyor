import { describe, expect, it, vi } from 'vitest'
import { labelsToTask } from '../src/board/board.js'
import { FakeBoard } from '../src/board/fake.js'
import { GitHubBoard } from '../src/board/github.js'
import { boardContract } from './board-contract.js'
import { createRun } from '../src/run.js'

boardContract('fake', () => new FakeBoard('tester'))

const sandbox = process.env.CONVEYOR_GITHUB_SANDBOX
if (sandbox) {
  const gh = async (...args: string[]) => {
    const result = await createRun()('gh', ['api', ...args])
    if (result.code !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  boardContract('github', () => new GitHubBoard(sandbox, createRun()), {
    timeout: 120_000,
    prepareBranch: async (id) => {
      const branch = await gh(`repos/${sandbox}`, '--jq', '.default_branch')
      const sha = await gh(`repos/${sandbox}/git/ref/heads/${branch}`, '--jq', '.object.sha')
      await gh('-X', 'POST', `repos/${sandbox}/git/refs`, '-f', `ref=refs/heads/conveyor/${id}`, '-f', `sha=${sha}`)
      await gh('-X', 'PUT', `repos/${sandbox}/contents/contract/${id}.txt`, '-f', `message=Contract test ${id}`, '-f', `content=${Buffer.from(`task ${id}\n`).toString('base64')}`, '-f', `branch=conveyor/${id}`)
    },
    removeBranch: async (id) => {
      await gh('-X', 'DELETE', `repos/${sandbox}/git/refs/heads/conveyor/${id}`).catch(() => undefined)
    },
  })
}

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

const projectNumber = Number(process.env.CONVEYOR_GITHUB_PROJECT)
if (sandbox && projectNumber) {
  describe('github project mirror', { timeout: 120_000 }, () => {
    it('mirrors the task state to the Conveyor field of the project', async () => {
      const warnings: string[] = []
      const board = new GitHubBoard(sandbox, createRun(), { projectNumber, warn: (message) => warnings.push(message) })
      const task = await board.createTask('Project mirror test', 'body', 'review')
      try {
        await board.setState(task.id, 'needs-input')
        const owner = sandbox.split('/')[0] ?? ''
        await vi.waitFor(
          async () => {
            const result = await createRun()('gh', ['project', 'item-list', String(projectNumber), '--owner', owner, '--format', 'json'])
            const items = (JSON.parse(result.stdout) as { items: { content?: { number?: number }; conveyor?: string }[] }).items
            expect(items.find((item) => item.content?.number === Number(task.id))?.conveyor).toBe('needs-input')
          },
          { timeout: 30_000, interval: 2_000 },
        )
        expect(warnings).toEqual([])
      } finally {
        await board.closeTask(task.id)
      }
    })
  })
}
