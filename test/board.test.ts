import { describe, expect, it, vi } from 'vitest'
import { labelsToTask, taskFile, taskOfFile, taskRef, taskSlug } from '../src/board/board.js'
import { FakeBoard } from '../src/board/fake.js'
import { GitHubBoard } from '../src/board/github.js'
import { GitLabBoard } from '../src/board/gitlab.js'
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
      const task = await board.createTask('Project mirror test', 'body', { state: 'review' })
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

const gitlab = process.env.CONVEYOR_GITLAB_SANDBOX
if (gitlab) {
  const api = `projects/${encodeURIComponent(gitlab)}`
  const glab = async (...args: string[]) => {
    for (let attempt = 1; ; attempt++) {
      const result = await createRun()('glab', ['api', ...args])
      if (result.code === 0) return result.stdout.trim()
      if (attempt >= 4 || !/dial tcp|i\/o timeout|connection reset|EOF/i.test(result.stderr)) throw new Error(result.stderr)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  boardContract('gitlab', () => new GitLabBoard(gitlab, createRun()), {
    timeout: 180_000,
    prepareBranch: async (id) => {
      await glab('-X', 'POST', `${api}/repository/branches`, '-f', `branch=conveyor/${id}`, '-f', 'ref=main')
      await glab('-X', 'POST', `${api}/repository/files/${encodeURIComponent(`contract/${id}.txt`)}`, '-f', 'branch=conveyor/' + id, '-f', `content=task ${id}`, '-f', `commit_message=Contract test ${id}`)
    },
    removeBranch: async (id) => {
      await glab('-X', 'DELETE', `${api}/repository/branches/${encodeURIComponent(`conveyor/${id}`)}`).catch(() => undefined)
    },
  })
}

const group = process.env.CONVEYOR_GITLAB_GROUP
const groupProject = process.env.CONVEYOR_GITLAB_GROUP_PROJECT
if (group && groupProject) {
  const glab = async (...args: string[]) => {
    for (let attempt = 1; ; attempt++) {
      const result = await createRun()('glab', ['api', ...args])
      if (result.code === 0) return result.stdout.trim()
      if (attempt >= 4 || !/dial tcp|i\/o timeout|connection reset|EOF/i.test(result.stderr)) throw new Error(result.stderr)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  const project = (path: string) => `projects/${encodeURIComponent(path)}`
  const make = () => new GitLabBoard(groupProject, createRun(), { group })
  boardContract('gitlab group', make, {
    timeout: 180_000,
    prepareBranch: async (id) => {
      const branch = `conveyor/${taskSlug(id)}`
      await glab('-X', 'POST', `${project(groupProject)}/repository/branches`, '-f', `branch=${branch}`, '-f', 'ref=develop')
      await glab('-X', 'POST', `${project(groupProject)}/repository/files/${encodeURIComponent(`contract/${taskFile(id)}.txt`)}`, '-f', `branch=${branch}`, '-f', `content=task ${id}`, '-f', `commit_message=Contract test ${id}`)
    },
    removeBranch: async (id) => {
      await glab('-X', 'DELETE', `${project(groupProject)}/repository/branches/${encodeURIComponent(`conveyor/${taskSlug(id)}`)}`).catch(() => undefined)
    },
  })

  describe('gitlab group board across projects', { timeout: 180_000 }, () => {
    it('lists, labels, comments, and blocks a task of another project of the group', async () => {
      const board = make()
      const other = (JSON.parse(await glab(`groups/${encodeURIComponent(group)}/projects?per_page=100`)) as { path_with_namespace: string }[]).map((item) => item.path_with_namespace).find((path) => path !== groupProject)
      if (!other) throw new Error(`the group ${group} needs a second project`)
      const created = JSON.parse(await glab('-X', 'POST', `${project(other)}/issues`, '-f', 'title=group contract task', '-f', 'description=body', '-f', 'labels=conveyor::backlog,form::plan')) as { iid: number }
      const id = `${other.slice(group.length + 1)}#${created.iid}`
      try {
        expect((await board.listTasks()).map((task) => task.id)).toContain(id)
        await board.setState(id, 'in-progress')
        expect((await board.getTask(id))?.state).toBe('in-progress')
        const comment = await board.addComment(id, 'first')
        await board.updateComment(comment.id, 'second')
        expect((await board.listComments(id)).map((item) => item.body)).toContain('second')
        const blocker = await board.createTask('group contract blocker', 'body', { state: 'backlog', form: 'plan' })
        await board.addBlocker(id, blocker.id)
        expect((await board.getTask(id))?.openBlockers).toBe(1)
        expect(board.reference(id)).toBe(`${other}#${created.iid}`)
        await board.closeTask(blocker.id)
      } finally {
        await glab('-X', 'PUT', `${project(other)}/issues/${created.iid}`, '-f', 'state_event=close')
      }
    })
  })
}

describe('task references', () => {
  it('turns a reference into a branch name, a flat file name, and back', () => {
    for (const id of ['12', 'frontend#12', 'shop/sub/user-service#7', 'svc-2#5']) expect(taskOfFile(taskFile(id))).toBe(id)
    expect(taskSlug('shop/frontend#12')).toBe('shop/frontend-12')
    expect(taskFile('shop/frontend#12')).toBe('shop+frontend-12')
    expect([taskRef('12'), taskRef('frontend#12')]).toEqual(['#12', 'frontend#12'])
  })
})
