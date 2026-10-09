import type { Run } from '../cli.js'
import {
  boardLabels,
  FORM_LABEL,
  labelsToTask,
  onBoard,
  OWNER_LABEL,
  PRIORITY_LABEL,
  STAGE_LABEL,
  STATE_LABEL,
  taskLabels,
  type Board,
  type Comment,
  type MergeMethod,
  type PullRequest,
  type Task,
  type TaskForm,
  type TaskLabels,
  type TaskState,
} from './board.js'

type GraphIssue = {
  iid: string
  title: string
  description: string | null
  webUrl: string
  author: { username: string }
  state: 'opened' | 'closed'
  createdAt: string
  blockedByCount: number | null
  labels: { nodes: { title: string }[] }
  assignees: { nodes: { username: string }[] }
}

type Note = { id: number; body: string; system: boolean; author: { username: string }; created_at: string; updated_at: string; position?: { new_path?: string; new_line?: number } | null }

type MergeRequest = {
  iid: number
  web_url: string
  sha: string
  state: 'opened' | 'merged' | 'closed' | 'locked'
  detailed_merge_status: string
  head_pipeline: { status: string } | null
}

type Call = { code: number; stdout: string; stderr: string; status: number }

const ISSUE_FIELDS = 'iid title description webUrl author { username } state createdAt blockedByCount labels { nodes { title } } assignees { nodes { username } }'
const BLOCKED_BY = /^Blocked by: (.+)$/m
const LOCK_PREFIX = 'conveyor-lock/'
const DEVELOPER = 30
const APPROVED = /^approved this merge request/
const NETWORK = /dial tcp|i\/o timeout|connection reset|EOF|TLS handshake timeout|connection refused/i
const CONNECT = /dial tcp/i

export class GitLabBoard implements Board {
  private readonly api: string
  private login?: string
  private defaultBranch?: string

  constructor(
    private readonly project: string,
    private readonly run: Run,
    private readonly options: { retryDelay?: number } = {},
  ) {
    this.api = `projects/${encodeURIComponent(project)}`
  }

  async user() {
    this.login ??= (await this.json<{ username: string }>(['user'])).username
    return this.login
  }

  async prepare(stages: string[]) {
    for (const label of boardLabels(stages)) {
      const result = await this.call(['-X', 'POST', `${this.api}/labels`, '-f', `name=${label.name}`, '-f', `color=#${label.color}`])
      if (result.code !== 0 && result.status !== 409) this.fail(result, 'labels')
    }
  }

  async canWrite(user: string) {
    if (!user) return false
    const members = await this.json<{ username: string; access_level: number }[]>([`${this.api}/members/all?query=${encodeURIComponent(user)}&per_page=100`])
    return members.some((member) => member.username === user && member.access_level >= DEVELOPER)
  }

  async createTask(title: string, body: string, labels: TaskLabels = {}) {
    const names = taskLabels(labels)
    const flags = names.length ? ['-f', `labels=${names.join(',')}`] : []
    const created = await this.json<{ iid: number }>(['-X', 'POST', `${this.api}/issues`, '-f', `title=${title}`, '-f', `description=${body}`, ...flags])
    const task = await this.getTask(String(created.iid))
    if (!task) throw new Error(`issue ${created.iid} not found after creation`)
    return task
  }

  async listTasks() {
    const issues: GraphIssue[] = []
    let after: string | null = null
    do {
      const cursor: string = after ? `, after: ${JSON.stringify(after)}` : ''
      const page: { nodes: GraphIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } } = (
        await this.graphql<{ project: { issues: { nodes: GraphIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } }>(
          `query { project(fullPath: ${JSON.stringify(this.project)}) { issues(state: opened, first: 100${cursor}) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
        )
      ).project.issues
      issues.push(...page.nodes)
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    } while (after)
    const tasks = await this.toTasks(issues)
    return tasks.filter(onBoard)
  }

  async getTask(id: string) {
    const data = await this.graphql<{ project: { issue: GraphIssue | null } }>(
      `query { project(fullPath: ${JSON.stringify(this.project)}) { issue(iid: ${JSON.stringify(id)}) { ${ISSUE_FIELDS} } } }`,
    )
    if (!data.project.issue) return undefined
    return (await this.toTasks([data.project.issue]))[0]
  }

  async setState(id: string, state: TaskState) {
    await this.replaceLabel(id, STATE_LABEL, STATE_LABEL + state)
  }

  async setForm(id: string, form: TaskForm | undefined) {
    await this.replaceLabel(id, FORM_LABEL, form ? FORM_LABEL + form : undefined)
  }

  async setStage(id: string, stage: string | undefined) {
    await this.replaceLabel(id, STAGE_LABEL, stage ? STAGE_LABEL + stage : undefined)
  }

  async setOwner(id: string, owner: string | undefined) {
    await this.replaceLabel(id, OWNER_LABEL, owner ? OWNER_LABEL + owner : undefined)
  }

  async setPriority(id: string, priority: number) {
    await this.replaceLabel(id, PRIORITY_LABEL, PRIORITY_LABEL + priority)
  }

  async updateBody(id: string, body: string) {
    const current = await this.json<{ description: string | null }>([`${this.api}/issues/${id}`])
    const blockers = current.description?.match(BLOCKED_BY)?.[0]
    const keep = blockers && !BLOCKED_BY.test(body) ? `${body}\n\n${blockers}` : body
    await this.json(['-X', 'PUT', `${this.api}/issues/${id}`, '-f', `description=${keep}`])
  }

  async closeTask(id: string) {
    await this.json(['-X', 'PUT', `${this.api}/issues/${id}`, '-f', 'state_event=close'])
  }

  async listComments(id: string) {
    const notes = await this.pages<Note>(`${this.api}/issues/${id}/notes?sort=asc&order_by=created_at`)
    return notes.filter((note) => !note.system).map((note) => toComment(id, note))
  }

  async addComment(id: string, body: string) {
    return toComment(id, await this.json<Note>(['-X', 'POST', `${this.api}/issues/${id}/notes`, '-f', `body=${body}`]))
  }

  async updateComment(commentId: string, body: string) {
    const [issue, note] = commentId.split(':')
    await this.json(['-X', 'PUT', `${this.api}/issues/${issue}/notes/${note}`, '-f', `body=${body}`])
  }

  async addBlocker(id: string, blockerId: string) {
    const project = await this.json<{ id: number }>([this.api])
    const linked = await this.call(['-X', 'POST', `${this.api}/issues/${id}/links`, '-f', `target_project_id=${project.id}`, '-f', `target_issue_iid=${blockerId}`, '-f', 'link_type=is_blocked_by'])
    if (linked.code === 0 || linked.status === 409) return
    if (![403, 404, 400].includes(linked.status)) this.fail(linked, 'issue link')
    const current = await this.json<{ description: string | null }>([`${this.api}/issues/${id}`])
    const description = current.description ?? ''
    const existing: string[] = description.match(BLOCKED_BY)?.[1]?.match(/#\d+/g) ?? []
    if (existing.includes(`#${blockerId}`)) return
    const line = `Blocked by: ${[...existing, `#${blockerId}`].join(', ')}`
    const updated = BLOCKED_BY.test(description) ? description.replace(BLOCKED_BY, line) : `${description}${description ? '\n\n' : ''}${line}`
    await this.json(['-X', 'PUT', `${this.api}/issues/${id}`, '-f', `description=${updated}`])
  }

  async claim(id: string) {
    const result = await this.call(['-X', 'POST', `${this.api}/repository/branches`, '-f', `branch=${LOCK_PREFIX}${id}`, '-f', `ref=${await this.branch()}`])
    if (result.status === 400 && /already exists/i.test(result.stderr + result.stdout)) return false
    if (result.code !== 0) this.fail(result, 'claim')
    return true
  }

  async release(id: string) {
    const result = await this.call(['-X', 'DELETE', `${this.api}/repository/branches/${encodeURIComponent(LOCK_PREFIX + id)}`])
    if (result.code !== 0 && result.status !== 404) this.fail(result, 'release')
  }

  async openPullRequest(id: string, title: string, body: string) {
    const existing = await this.pullRequest(id)
    if (existing?.state === 'open') return existing
    await this.json(['-X', 'POST', `${this.api}/merge_requests`, '-f', `source_branch=conveyor/${id}`, '-f', `target_branch=${await this.branch()}`, '-f', `title=${title}`, '-f', `description=${body}`])
    const opened = await this.pullRequest(id)
    if (!opened) throw new Error(`merge request for task ${id} not found after creation`)
    return opened
  }

  async pullRequest(id: string): Promise<PullRequest | undefined> {
    const listed = await this.json<MergeRequest[]>([`${this.api}/merge_requests?source_branch=${encodeURIComponent(`conveyor/${id}`)}&state=all&order_by=created_at&sort=desc`])
    const first = listed[0]
    if (!first) return undefined
    const request = await this.json<MergeRequest>([`${this.api}/merge_requests/${first.iid}`])
    const approvals = await this.json<{ approved_by: { user: { username: string } }[] }>([`${this.api}/merge_requests/${first.iid}/approvals`])
    const reviewers = await this.json<{ user: { username: string }; state: string; updated_at?: string; created_at?: string }[]>([
      `${this.api}/merge_requests/${first.iid}/reviewers`,
    ])
    const all = await this.pages<Note>(`${this.api}/merge_requests/${first.iid}/notes?sort=asc&order_by=created_at`)
    const notes = all.filter((note) => !note.system)
    const approvedAt = new Map(all.filter((note) => note.system && APPROVED.test(note.body)).map((note) => [note.author.username, note.created_at]))
    const now = new Date().toISOString()
    return {
      number: String(request.iid),
      url: request.web_url,
      headSha: request.sha,
      state: request.state === 'opened' || request.state === 'locked' ? 'open' : request.state,
      checks: checks(request.head_pipeline?.status),
      mergeable: mergeable(request.detailed_merge_status),
      feedback: notes
        .filter((note) => note.position)
        .map((note) => ({ author: note.author.username, body: `${note.position?.new_path ?? ''}${note.position?.new_line ? `:${note.position.new_line}` : ''}: ${note.body}` })),
      reviews: [
        ...approvals.approved_by.flatMap(({ user }) => {
          const submittedAt = approvedAt.get(user.username)
          return submittedAt ? [{ author: user.username, state: 'approved' as const, body: '', submittedAt }] : []
        }),
        ...reviewers
          .filter((reviewer) => reviewer.state === 'requested_changes')
          .map((reviewer) => ({ author: reviewer.user.username, state: 'changes_requested' as const, body: '', submittedAt: reviewer.updated_at ?? reviewer.created_at ?? now })),
      ],
      comments: notes.filter((note) => !note.position).map((note) => ({ author: note.author.username, body: note.body, createdAt: note.created_at })),
    }
  }

  async mergePullRequest(id: string, method: MergeMethod, sha: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const pull = await this.pullRequest(id)
    if (!pull || pull.state !== 'open') return { ok: false, error: 'no open merge request' }
    const result = await this.call(['-X', 'PUT', `${this.api}/merge_requests/${pull.number}/merge`, '-f', `sha=${sha}`, ...(method === 'squash' ? ['-F', 'squash=true'] : [])])
    return result.code === 0 ? { ok: true } : { ok: false, error: (result.stderr || result.stdout).trim() || `merge failed with HTTP ${result.status}` }
  }

  async commentPullRequest(id: string, body: string) {
    const pull = await this.pullRequest(id)
    if (!pull) throw new Error(`task ${id} has no merge request`)
    await this.json(['-X', 'POST', `${this.api}/merge_requests/${pull.number}/notes`, '-f', `body=${body}`])
  }

  async closePullRequest(id: string) {
    const pull = await this.pullRequest(id)
    if (pull?.state === 'open') await this.json(['-X', 'PUT', `${this.api}/merge_requests/${pull.number}`, '-f', 'state_event=close'])
  }

  private async toTasks(issues: GraphIssue[]): Promise<Task[]> {
    const referenced = [...new Set(issues.flatMap((issue) => fallbackBlockers(issue.description)))]
    const open = new Set<string>()
    if (referenced.length > 0) {
      const states = await this.graphql<{ project: { issues: { nodes: { iid: string; state: string }[] } } }>(
        `query { project(fullPath: ${JSON.stringify(this.project)}) { issues(iids: ${JSON.stringify(referenced)}, first: 100) { nodes { iid state } } } }`,
      )
      for (const node of states.project.issues.nodes) if (node.state === 'opened') open.add(node.iid)
    }
    return issues.map((issue) => ({
      id: issue.iid,
      title: issue.title,
      body: (issue.description ?? '').replace(BLOCKED_BY, '').trim(),
      author: issue.author.username,
      url: issue.webUrl,
      assignees: issue.assignees.nodes.map((node) => node.username),
      openBlockers: (issue.blockedByCount ?? 0) + fallbackBlockers(issue.description).filter((iid) => open.has(iid)).length,
      closed: issue.state === 'closed',
      createdAt: issue.createdAt,
      ...labelsToTask(issue.labels.nodes.map((node) => node.title)),
    }))
  }

  private async replaceLabel(id: string, prefix: string, label: string | undefined) {
    const issue = await this.json<{ labels: string[] }>([`${this.api}/issues/${id}`])
    const remove = issue.labels.filter((name) => name.startsWith(prefix) && name !== label)
    const add = label && !issue.labels.includes(label) ? [label] : []
    if (remove.length === 0 && add.length === 0) return
    await this.json([
      '-X', 'PUT', `${this.api}/issues/${id}`,
      ...(add.length ? ['-f', `add_labels=${add.join(',')}`] : []),
      ...(remove.length ? ['-f', `remove_labels=${remove.join(',')}`] : []),
    ])
  }

  private async branch() {
    this.defaultBranch ??= (await this.json<{ default_branch: string }>([this.api])).default_branch
    return this.defaultBranch
  }

  private async pages<T>(path: string): Promise<T[]> {
    const items: T[] = []
    for (let page = 1; ; page++) {
      const batch = await this.json<T[]>([`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`])
      items.push(...batch)
      if (batch.length < 100) return items
    }
  }

  private async graphql<T>(query: string): Promise<T> {
    const response = await this.json<{ data?: T; errors?: { message: string }[] }>(['graphql', '-f', `query=${query}`])
    if (!response.data || response.errors?.length) throw new Error(`GitLab GraphQL failed: ${response.errors?.map((error) => error.message).join('; ') ?? 'no data'}`)
    return response.data
  }

  private async call(args: string[]): Promise<Call> {
    const write = args.includes('-X') && args[args.indexOf('-X') + 1] !== 'GET'
    for (let attempt = 1; ; attempt++) {
      const result = await this.run('glab', ['api', ...args])
      const status = Number(`${result.stderr}${result.stdout}`.match(/\(HTTP (\d{3})\)/)?.[1] ?? (result.code === 0 ? 200 : 0))
      const transient = result.code !== 0 && status === 0 && (write ? CONNECT : NETWORK).test(result.stderr)
      if (!transient || attempt >= 4) return { ...result, status }
      await new Promise((resolve) => setTimeout(resolve, (this.options.retryDelay ?? 2_000) * attempt))
    }
  }

  private async json<T = unknown>(args: string[]): Promise<T> {
    const result = await this.call(args)
    if (result.code !== 0) this.fail(result, args.filter((arg) => !arg.startsWith('-')).slice(0, 2).join(' '))
    return (result.stdout.trim() ? JSON.parse(result.stdout) : undefined) as T
  }

  private fail(result: Call, what: string): never {
    throw new Error(`glab api ${what} failed (HTTP ${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`)
  }
}

function fallbackBlockers(description: string | null): string[] {
  return [...(description?.match(BLOCKED_BY)?.[1]?.matchAll(/#(\d+)/g) ?? [])].map((match) => match[1] ?? '').filter(Boolean)
}

function checks(status: string | undefined): PullRequest['checks'] {
  if (!status) return 'none'
  if (status === 'success') return 'success'
  if (['failed', 'canceled', 'canceling'].includes(status)) return 'failure'
  if (['skipped', 'manual'].includes(status)) return 'none'
  return 'pending'
}

function mergeable(status: string): PullRequest['mergeable'] {
  if (status === 'mergeable') return 'yes'
  if (['conflict', 'need_rebase'].includes(status)) return 'no'
  if (['checking', 'unchecked', 'preparing', 'approvals_syncing', 'ci_still_running'].includes(status)) return 'unknown'
  return 'yes'
}

function toComment(issue: string, note: Note): Comment {
  return { id: `${issue}:${note.id}`, author: note.author.username, body: note.body, createdAt: note.created_at, updatedAt: note.updated_at }
}
