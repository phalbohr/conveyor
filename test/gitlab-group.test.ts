import { describe, expect, it } from 'vitest'
import { GitLabBoard } from '../src/board/gitlab.js'
import type { Run } from '../src/cli.js'

const GROUP = 'shop'

function gitlabGroup() {
  const calls: string[] = []
  const raw: string[][] = []
  const issues: Record<string, { description: string; state: 'opened' | 'closed'; labels: string[] }> = {
    'shop/frontend#12': { description: 'Checkout\n\nBlocked by: user-service#3', state: 'opened', labels: ['conveyor::backlog', 'form::plan'] },
    'shop/user-service#3': { description: 'Accounts', state: 'opened', labels: ['conveyor::backlog', 'form::plan'] },
    'shop/docs#1': { description: 'Notes', state: 'opened', labels: [] },
  }
  const graphIssue = (reference: string) => ({
    iid: reference.split('#')[1],
    reference,
    title: `Issue ${reference}`,
    description: issues[reference]?.description ?? '',
    webUrl: `https://gitlab.example/${reference.replace('#', '/-/issues/')}`,
    state: issues[reference]?.state ?? 'opened',
    createdAt: '2026-10-14T00:00:00Z',
    blockedByCount: null,
    labels: { nodes: (issues[reference]?.labels ?? []).map((title) => ({ title })) },
    assignees: { nodes: [] },
    author: { username: 'alice' },
  })
  const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
  const run: Run = async (_command, args) => {
    const call = args.slice(1)
    raw.push(call)
    const field = (name: string) => call.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
    const path = call.find((arg) => /^(projects|groups)\//.test(arg) || arg === 'graphql' || arg === 'user') ?? ''
    calls.push(`${call.includes('-X') ? call[call.indexOf('-X') + 1] : 'GET'} ${path === 'graphql' ? `graphql ${(field('query') ?? '').slice(0, 60)}` : path}`)
    if (path === 'graphql') {
      const query = field('query') ?? ''
      const project = query.match(/project\(fullPath: "([^"]+)"\)/)?.[1]
      const iids = query.match(/iids: (\[[^\]]*\])/)?.[1]
      if (project && iids) return ok({ data: { project: { issues: { nodes: (JSON.parse(iids) as string[]).map((iid) => ({ iid, state: issues[`${project}#${iid}`]?.state })) } } } })
      const iid = query.match(/issue\(iid: "(\d+)"\)/)?.[1]
      if (project && iid) return ok({ data: { project: { issue: issues[`${project}#${iid}`] ? graphIssue(`${project}#${iid}`) : null } } })
      return ok({ data: { scope: { issues: { nodes: Object.keys(issues).map(graphIssue), pageInfo: { hasNextPage: false, endCursor: '' } } } } })
    }
    if (path === `projects/${encodeURIComponent('shop/frontend')}/issues` && call.includes('POST')) {
      issues['shop/frontend#13'] = { description: field('description') ?? '', state: 'opened', labels: (field('labels') ?? '').split(',').filter(Boolean) }
      return ok({ references: { full: 'shop/frontend#13' } })
    }
    if (path.endsWith('/notes')) return ok({ id: 5, body: field('body'), system: false, author: { username: 'me' }, created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' })
    if (path.endsWith('/links')) return { code: 1, stdout: '', stderr: 'glab: 403 Forbidden (HTTP 403)' }
    const issue = path.match(/^projects\/([^/]+)\/issues\/(\d+)$/)
    if (issue) {
      const reference = `${decodeURIComponent(issue[1] ?? '')}#${issue[2]}`
      const description = field('description')
      if (call.includes('PUT') && description !== undefined) (issues[reference] as { description: string }).description = description
      return ok({ description: issues[reference]?.description ?? '', labels: issues[reference]?.labels ?? [], assignees: [] })
    }
    if (call.some((arg) => arg.startsWith('users?username='))) return ok([{ id: 77 }])
    if (path === `groups/${GROUP}/members/all?query=alice&per_page=100`) return ok([{ username: 'alice', access_level: 30 }])
    if (path === `groups/${GROUP}`) return ok({ web_url: 'https://gitlab.example/groups/shop' })
    if (path === `projects/${encodeURIComponent('shop/frontend')}`) return ok({ id: 7, web_url: 'https://gitlab.example/shop/frontend', default_branch: 'develop' })
    if (path === `projects/${encodeURIComponent('shop/inventory')}`) return ok({ id: 11, default_branch: 'develop' })
    if (path.startsWith('projects/')) return ok(path.includes('/merge_requests') ? [] : { id: 9 })
    return ok([])
  }
  return { board: new GitLabBoard('shop/frontend', run, { retryDelay: 0, group: GROUP, repos: { group: GROUP, base: { 'user-service': 'main' } } }), issues, calls, raw }
}

describe('GitLabBoard on a group board', () => {
  it('lists the tasks of every project of the group by their reference and counts blockers across projects', async () => {
    const { board, issues } = gitlabGroup()
    const tasks = await board.listTasks()
    expect(tasks.map((task) => [task.id, task.openBlockers])).toEqual([
      ['frontend#12', 1],
      ['user-service#3', 0],
    ])
    ;(issues['shop/user-service#3'] as { state: string }).state = 'closed'
    expect((await board.getTask('frontend#12'))?.openBlockers).toBe(0)
    expect(await board.getTask('payment#4')).toBeUndefined()
  })

  it('works on the issue in its own project and keeps merge requests and locks in the main project', async () => {
    const { board, calls } = gitlabGroup()
    await board.setState('user-service#3', 'in-progress')
    await board.addComment('user-service#3', 'note')
    await board.claim('user-service#3')
    expect(calls).toContain(`PUT projects/${encodeURIComponent('shop/user-service')}/issues/3`)
    expect(calls).toContain(`POST projects/${encodeURIComponent('shop/user-service')}/issues/3/notes`)
    expect(calls).toContain(`POST projects/${encodeURIComponent('shop/frontend')}/repository/branches`)
    expect(board.reference('user-service#3')).toBe('shop/user-service#3')
    expect(await board.branchUrl('conveyor/user-service-3')).toBe('https://gitlab.example/shop/frontend/-/tree/conveyor/user-service-3')
  })

  it('creates tasks in the main project, prepares group labels, and checks members of the group', async () => {
    const { board, calls } = gitlabGroup()
    expect((await board.createTask('Search', 'text', { state: 'backlog', form: 'idea' })).id).toBe('frontend#13')
    await board.prepare(['implement'])
    expect(calls).toContain(`POST groups/${GROUP}/labels`)
    expect(await board.canWrite('alice')).toBe(true)
    expect(await board.boardUrl()).toBe('https://gitlab.example/groups/shop/-/boards')
  })

  it('writes blockers in other projects of the group into the description on Free', async () => {
    const { board, issues } = gitlabGroup()
    await board.addBlocker('user-service#3', 'frontend#12')
    await board.addBlocker('user-service#3', 'frontend#12')
    expect(issues['shop/user-service#3']?.description).toBe('Accounts\n\nBlocked by: frontend#12')
  })

  it('sends assignees as one JSON array, because new glab versions reject field names with brackets', async () => {
    const { board, raw } = gitlabGroup()
    await board.setOwner('user-service#3', 'alice')
    const update = raw.find((call) => call.includes('PUT') && call.some((arg) => arg.startsWith('assignee_ids')))
    expect(update).toContain('assignee_ids=[77]')
    expect(update?.[update.indexOf('assignee_ids=[77]') - 1]).toBe('-F')
    expect(raw.flat().some((arg) => /^\w+\[\]=/.test(arg))).toBe(false)
  })

  it('sends merge request, base, and check calls of a task repository to that project', async () => {
    const { board, calls } = gitlabGroup()
    expect(await board.pullRequest('frontend#12', 'user-service')).toBeUndefined()
    expect(calls.some((call) => call.startsWith(`GET projects/${encodeURIComponent('shop/user-service')}/merge_requests?source_branch=${encodeURIComponent('conveyor/frontend-12')}`))).toBe(true)
    expect(await board.baseBranch('user-service')).toBe('main')
    expect(await board.baseBranch('inventory')).toBe('develop')
    expect(await board.baseBranch()).toBe('develop')
    await board.commitChecks('abc', 'user-service').catch(() => undefined)
    expect(calls).toContain(`GET projects/${encodeURIComponent('shop/user-service')}/repository/commits/abc`)
  })

  it('sends the calls of a repository from another group to its full path', async () => {
    const calls: string[][] = []
    const board = new GitLabBoard('shop/frontend', async (_command, args) => {
      calls.push(args)
      return { code: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' }
    }, { retryDelay: 0, group: GROUP, repos: { paths: { 'handbook': 'tools/handbook' }, base: {} } })
    expect(await board.baseBranch('handbook')).toBe('main')
    expect(calls).toContainEqual(['api', `projects/${encodeURIComponent('tools/handbook')}`])
  })

  it('names the group when GitLab does not find it', async () => {
    const run: Run = async () => ({ code: 0, stdout: JSON.stringify({ data: { scope: null } }), stderr: '' })
    const board = new GitLabBoard('acme/shop/frontend', run, { retryDelay: 0, group: 'acme/shop' })
    await expect(board.listTasks()).rejects.toThrow('GitLab group acme/shop was not found, or you have no access to it; check board.group in config.yaml')
    await expect(new GitLabBoard('acme/app', run, { retryDelay: 0 }).listTasks()).rejects.toThrow('GitLab project acme/app was not found')
  })
})
