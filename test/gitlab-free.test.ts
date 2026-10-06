import { describe, expect, it } from 'vitest'
import { GitLabBoard } from '../src/board/gitlab.js'
import type { Run } from '../src/cli.js'

function gitlabFree() {
  const issues: Record<string, { description: string; state: 'opened' | 'closed' }> = {
    '1': { description: 'Feature text', state: 'opened' },
    '2': { description: 'Foundation', state: 'opened' },
  }
  const graphIssue = (iid: string) => ({
    iid,
    title: `Issue ${iid}`,
    description: issues[iid]?.description ?? '',
    state: issues[iid]?.state ?? 'opened',
    createdAt: '2026-10-05T00:00:00Z',
    blockedByCount: 0,
    labels: { nodes: [{ title: 'conveyor::plan' }] },
    assignees: { nodes: [] },
    author: { username: 'alice' },
  })
  const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  const run: Run = async (_command, args) => {
    const call = args.slice(1)
    const field = (name: string) => call.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
    const path = call.find((arg) => arg.startsWith('projects/') || arg === 'graphql') ?? ''
    if (path === 'graphql') {
      const query = field('query') ?? ''
      const iids = query.match(/iids: (\[[^\]]*\])/)?.[1]
      if (iids) return ok({ data: { project: { issues: { nodes: (JSON.parse(iids) as string[]).map((iid) => ({ iid, state: issues[iid]?.state })) } } } })
      const iid = query.match(/issue\(iid: "(\d+)"\)/)?.[1] ?? ''
      return ok({ data: { project: { issue: graphIssue(iid) } } })
    }
    if (path.endsWith('/links')) return { code: 1, stdout: '', stderr: 'glab: 403 Forbidden (HTTP 403)' }
    const issue = path.match(/issues\/(\d+)$/)?.[1]
    if (issue && call.includes('PUT')) {
      const description = field('description')
      if (description !== undefined) (issues[issue] as { description: string }).description = description
      return ok({})
    }
    if (issue) return ok({ description: issues[issue]?.description ?? '', labels: [] })
    return ok({ id: 42 })
  }
  return { board: new GitLabBoard('group/project', run, { retryDelay: 0 }), issues }
}

describe('GitLabBoard without issue links (Free)', () => {
  it('stores blockers in the description and counts only open ones', async () => {
    const { board, issues } = gitlabFree()

    await board.addBlocker('1', '2')
    await board.addBlocker('1', '2')

    expect(issues['1']?.description).toBe('Feature text\n\nBlocked by: #2')
    expect(await board.getTask('1')).toMatchObject({ openBlockers: 1, body: 'Feature text' })

    ;(issues['2'] as { state: string }).state = 'closed'
    expect((await board.getTask('1'))?.openBlockers).toBe(0)
  })

  it('keeps the blocker line when the body is replaced', async () => {
    const { board, issues } = gitlabFree()
    await board.addBlocker('1', '2')
    await board.updateBody('1', 'The story')
    expect(issues['1']?.description).toBe('The story\n\nBlocked by: #2')
  })
})
