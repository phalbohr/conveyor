import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Board, Task, TaskState } from '../src/board/board.js'

const eventually = (assertion: () => Promise<void>) => vi.waitFor(assertion, { timeout: 30_000, interval: 1_000 })

type ContractOptions = {
  timeout?: number
  prepareBranch?: (id: string) => Promise<void>
  removeBranch?: (id: string) => Promise<void>
}

export function boardContract(name: string, makeBoard: () => Board, options: ContractOptions = {}) {
  describe(`${name} board contract`, { timeout: options.timeout ?? 5_000 }, () => {
    const board = makeBoard()
    const created: string[] = []

    async function task(labels: TaskLabels = {}, title = 'contract test task'): Promise<Task> {
      const result = await board.createTask(title, 'body', labels)
      created.push(result.id)
      return result
    }

    const branches: string[] = []

    async function branch(id: string) {
      await options.prepareBranch?.(id)
      branches.push(id)
    }

    afterAll(async () => {
      for (const id of created) await board.closeTask(id)
      for (const id of branches) await options.removeBranch?.(id)
    }, 120_000)

    it('creates a task with a form and lists it', async () => {
      const created = await task({ state: 'backlog', form: 'idea' })
      expect(created).toMatchObject({ title: 'contract test task', body: 'body', state: 'backlog', form: 'idea', closed: false, openBlockers: 0 })
      await eventually(async () => {
        expect((await board.listTasks()).map((t) => t.id)).toContain(created.id)
      })
      expect(await board.getTask(created.id)).toMatchObject({ id: created.id, state: 'backlog', form: 'idea' })
    })

    it('does not list tasks without a conveyor state', async () => {
      const plain = await task()
      expect(plain.state).toBeUndefined()
      expect((await board.listTasks()).map((t) => t.id)).not.toContain(plain.id)
    })

    it('does not list closed tasks', async () => {
      const closed = await task({ form: 'plan' })
      await board.closeTask(closed.id)
      await eventually(async () => {
        expect((await board.listTasks()).map((t) => t.id)).not.toContain(closed.id)
      })
      expect(await board.getTask(closed.id)).toMatchObject({ closed: true })
    })

    it('replaces the state', async () => {
      const t = await task({ form: 'story' })
      await board.setState(t.id, 'in-progress')
      await board.setState(t.id, 'needs-input')
      expect((await board.getTask(t.id))?.state).toBe('needs-input')
    })

    it('sets and clears the owner', async () => {
      const t = await task({ form: 'plan' })
      await board.setOwner(t.id, 'someone')
      expect((await board.getTask(t.id))?.owner).toBe('someone')
      await board.setOwner(t.id, undefined)
      expect((await board.getTask(t.id))?.owner).toBeUndefined()
    })

    it('updates the body', async () => {
      const t = await task({ form: 'idea' })
      await board.updateBody(t.id, 'story text')
      expect((await board.getTask(t.id))?.body).toBe('story text')
    })

    it('adds, lists, and updates comments', async () => {
      const t = await task({ form: 'plan' })
      const user = await board.user()
      const first = await board.addComment(t.id, 'first')
      await board.addComment(t.id, 'second')
      await board.updateComment(first.id, 'first, edited')
      const comments = await board.listComments(t.id)
      expect(comments.map((c) => c.body)).toEqual(['first, edited', 'second'])
      expect(comments[0]?.author).toBe(user)
    })

    it('prepares the state labels more than once without errors', async () => {
      await board.prepare(['implement'])
      await board.prepare(['implement'])
      const t = await task({ form: 'plan' })
      await board.setState(t.id, 'in-progress')
      await board.setForm(t.id, undefined)
      await board.setStage(t.id, 'implement')
      expect(await board.getTask(t.id)).toMatchObject({ state: 'in-progress', stage: 'implement' })
      expect((await board.getTask(t.id))?.form).toBeUndefined()
      await board.setStage(t.id, undefined)
      expect((await board.getTask(t.id))?.stage).toBeUndefined()
    })

    it('tells who has write access', async () => {
      expect(await board.canWrite(await board.user())).toBe(true)
      expect(await board.canWrite('')).toBe(false)
    })

    it('reports the author of a task', async () => {
      const t = await task({ form: 'plan' })
      expect((await board.getTask(t.id))?.author).toBe(await board.user())
    })

    it('counts open blockers', async () => {
      const blocked = await task({ form: 'plan' }, 'blocked task')
      const blocker = await task({ form: 'plan' }, 'blocker task')
      await board.addBlocker(blocked.id, blocker.id)
      await eventually(async () => {
        expect((await board.getTask(blocked.id))?.openBlockers).toBe(1)
      })
      await board.closeTask(blocker.id)
      await eventually(async () => {
        expect((await board.getTask(blocked.id))?.openBlockers).toBe(0)
      })
    })

    it('claims a task only once until release', async () => {
      const t = await task({ form: 'plan' })
      expect(await board.claim(t.id)).toBe(true)
      expect(await board.claim(t.id)).toBe(false)
      await board.release(t.id)
      expect(await board.claim(t.id)).toBe(true)
      await board.release(t.id)
    })

    it('replaces the priority', async () => {
      const t = await task({ form: 'plan' })
      await board.setPriority(t.id, 3)
      await board.setPriority(t.id, 1)
      expect((await board.getTask(t.id))?.priority).toBe(1)
    })

    it('has no pull request for a new task', async () => {
      const t = await task({ form: 'plan' })
      expect(await board.pullRequest(t.id)).toBeUndefined()
    })

    it('opens one pull request for the task branch and merges it', async () => {
      const t = await task({ state: 'review' })
      await branch(t.id)
      const opened = await board.openPullRequest(t.id, `Task ${t.id}`, 'Part of the contract test.')
      expect(opened).toMatchObject({ state: 'open', reviews: [], feedback: [] })
      expect((await board.openPullRequest(t.id, `Task ${t.id}`, 'again')).number).toBe(opened.number)
      expect((await board.pullRequest(t.id))?.number).toBe(opened.number)

      await eventually(async () => {
        expect((await board.pullRequest(t.id))?.mergeable).toBe('yes')
      })
      expect(opened.headSha).toMatch(/\w{6,}/)
      expect(await board.mergePullRequest(t.id, 'squash', 'f'.repeat(40))).toMatchObject({ ok: false })
      expect((await board.pullRequest(t.id))?.state).toBe('open')
      expect(await board.mergePullRequest(t.id, 'squash', opened.headSha)).toEqual({ ok: true })
      expect((await board.pullRequest(t.id))?.state).toBe('merged')
      expect((await board.getTask(t.id))?.closed).toBe(false)
    })

    it('closes a pull request', async () => {
      const t = await task({ state: 'review' })
      await branch(t.id)
      await board.openPullRequest(t.id, `Task ${t.id}`, 'Part of the contract test.')
      await board.closePullRequest(t.id)
      expect((await board.pullRequest(t.id))?.state).toBe('closed')
    })

    it('releases an unclaimed task without error', async () => {
      const t = await task({ form: 'plan' })
      await board.release(t.id)
    })
  })
}
