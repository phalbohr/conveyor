import type { Run } from '../cli.js'
import {
  type LinkedPull,
  boardLabels,
  CONVEYOR_PREFIXES,
  FORM_LABEL,
  labelsToTask,
  onBoard,
  OWNER_LABEL,
  PART_LABEL,
  FIX_LABEL,
  PRIORITY_LABEL,
  STAGE_LABEL,
  STATE_LABEL,
  taskLabels,
  taskSlug,
  type Board,
  type BoardInspection,
  type LinkedProject,
  type Comment,
  type MergeMethod,
  type PullRequest,
  type Task,
  type TaskForm,
  type TaskLabels,
  type TaskState,
  ignoredCheck,
  type Where,
} from './board.js'

type GraphIssue = {
  iid: string
  reference: string
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
  head_pipeline: { id: number; status: string } | null
  draft?: boolean
  source_project_id?: number
  target_project_id?: number
}

type Call = { code: number; stdout: string; stderr: string; status: number }

const ISSUE_FIELDS = 'iid reference(full: true) title description webUrl author { username } state createdAt blockedByCount labels { nodes { title } } assignees { nodes { username } }'
const BLOCKED_BY = /^Blocked by: (.+)$/m
const LOCK_PREFIX = 'conveyor-lock/'
const DEVELOPER = 30
const APPROVED = /^approved this merge request/
const NETWORK = /dial tcp|i\/o timeout|connection reset|EOF|TLS handshake timeout|connection refused/i
const CONNECT = /dial tcp/i

export class GitLabBoard implements Board {
  private readonly api: string
  private readonly scope: string
  private login?: string
  private defaultBranch?: string
  private webUrl?: string
  private readonly repoBranches = new Map<string, string>()

  constructor(
    private readonly project: string,
    private readonly run: Run,
    private readonly options: { retryDelay?: number; baseBranch?: string; group?: string; repos?: { group?: string; paths?: Record<string, string>; base: Record<string, string> }; ignoreChecks?: string[] } = {},
  ) {
    this.api = `projects/${encodeURIComponent(project)}`
    this.scope = options.group ? `groups/${encodeURIComponent(options.group)}` : this.api
  }

  reference(id: string) {
    const issue = this.split(id)
    return this.options.group ? `${issue.project}#${issue.iid}` : `#${id}`
  }

  async branchUrl(branch: string) {
    this.webUrl ??= (await this.json<{ web_url: string }>([this.api])).web_url
    return `${this.webUrl}/-/tree/${branch}`
  }

  private split(id: string) {
    const at = id.lastIndexOf('#')
    if (at < 0 || !this.options.group) return { project: this.project, iid: id }
    return { project: `${this.options.group}/${id.slice(0, at)}`, iid: id.slice(at + 1) }
  }

  private issuePath(id: string) {
    const issue = this.split(id)
    return `projects/${encodeURIComponent(issue.project)}/issues/${issue.iid}`
  }

  private idOf(reference: string) {
    const at = reference.lastIndexOf('#')
    const project = reference.slice(0, at)
    const iid = reference.slice(at + 1)
    const group = this.options.group
    return group && project.toLowerCase().startsWith(`${group.toLowerCase()}/`) ? `${project.slice(group.length + 1)}#${iid}` : iid
  }

  async user() {
    this.login ??= (await this.json<{ username: string }>(['user'])).username
    return this.login
  }

  async prepare(stages: string[]) {
    for (const label of boardLabels(stages)) {
      const result = await this.call(['-X', 'POST', `${this.scope}/labels`, '-f', `name=${label.name}`, '-f', `color=#${label.color}`])
      if (result.code !== 0 && result.status !== 409) this.fail(result, 'labels')
    }
  }

  async inspect(): Promise<BoardInspection> {
    const labels = (await this.pages<{ name: string }>(`${this.scope}/labels?include_ancestor_groups=false`)).map((label) => label.name)
    const issues = (await this.pages<{ references: { full: string }; title: string; labels: string[] }>(`${this.scope}/issues?state=opened`))
      .map((issue) => ({ id: this.idOf(issue.references.full), title: issue.title, labels: issue.labels }))
      .filter((issue) => issue.labels.some((label) => CONVEYOR_PREFIXES.some((prefix) => label.startsWith(prefix))))
    return { labels, issues }
  }

  async linkedProjects(): Promise<LinkedProject[]> {
    return []
  }

  async createProject(): Promise<LinkedProject> {
    throw new Error('GitLab boards need no separate project')
  }

  async syncMirror() {
    return 0
  }

  async boardUrl() {
    return `${(await this.json<{ web_url: string }>([this.scope])).web_url}/-/boards`
  }

  async canWrite(user: string, where: Where = {}) {
    if (!user) return false
    const own = where.repo ? this.repoApi(where.repo) : where.task && this.options.group ? `projects/${encodeURIComponent(this.split(where.task).project)}` : this.scope
    for (const path of new Set([own, ...(where.repos ?? []).map((repo) => this.repoApi(repo))])) {
      const members = await this.json<{ username: string; access_level: number }[]>([`${path}/members/all?query=${encodeURIComponent(user)}&per_page=100`])
      if (!members.some((member) => member.username === user && member.access_level >= DEVELOPER)) return false
    }
    return true
  }

  async createTask(title: string, body: string, labels: TaskLabels = {}) {
    const names = taskLabels(labels)
    const flags = names.length ? ['-f', `labels=${names.join(',')}`] : []
    const created = await this.json<{ references: { full: string } }>(['-X', 'POST', `${this.api}/issues`, '-f', `title=${title}`, '-f', `description=${body}`, ...flags])
    const task = await this.getTask(this.idOf(created.references.full))
    if (!task) throw new Error(`issue ${created.references.full} not found after creation`)
    return task
  }

  async listTasks() {
    const issues: GraphIssue[] = []
    let after: string | null = null
    do {
      const cursor: string = after ? `, after: ${JSON.stringify(after)}` : ''
      const scope = this.options.group ? `group(fullPath: ${JSON.stringify(this.options.group)})` : `project(fullPath: ${JSON.stringify(this.project)})`
      const found = await this.graphql<{ scope: { issues: { nodes: GraphIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null }>(
        `query { scope: ${scope} { issues(state: opened, ${this.options.group ? 'includeSubgroups: true, ' : ''}first: 100${cursor}) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
      )
      if (!found.scope) throw new Error(`GitLab ${this.options.group ? `group ${this.options.group}` : `project ${this.project}`} was not found, or you have no access to it; check board.${this.options.group ? 'group' : 'project'} in config.yaml`)
      const page = found.scope.issues
      issues.push(...page.nodes)
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    } while (after)
    const tasks = await this.toTasks(issues)
    return tasks.filter(onBoard)
  }

  async getTask(id: string) {
    const issue = this.split(id)
    const data = await this.graphql<{ project: { issue: GraphIssue | null } | null }>(
      `query { project(fullPath: ${JSON.stringify(issue.project)}) { issue(iid: ${JSON.stringify(issue.iid)}) { ${ISSUE_FIELDS} } } }`,
    )
    if (!data.project) return undefined
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

  async setPart(id: string, part: string | undefined) {
    await this.replaceLabel(id, PART_LABEL, part ? PART_LABEL + part : undefined)
  }

  async setFixing(id: string, fixing: boolean) {
    await this.replaceLabel(id, FIX_LABEL, fixing ? FIX_LABEL : undefined)
  }

  async setOwner(id: string, owner: string | undefined) {
    const issue = await this.json<{ labels: string[]; assignees: { id: number; username: string }[] }>([`${this.issuePath(id)}`])
    const previous = issue.labels.find((name) => name.startsWith(OWNER_LABEL))?.slice(OWNER_LABEL.length)
    await this.replaceLabel(id, OWNER_LABEL, owner ? OWNER_LABEL + owner : undefined)
    const kept = issue.assignees.filter(({ username }) => username !== previous || username === owner).map(({ id: user }) => user)
    const added = owner && !issue.assignees.some(({ username }) => username === owner) ? [await this.userId(owner)] : []
    const ids = [...kept, ...added]
    if (ids.length === issue.assignees.length && added.length === 0) return
    await this.json(['-X', 'PUT', `${this.issuePath(id)}`, '-F', `assignee_ids=${JSON.stringify(ids)}`])
  }

  private async userId(username: string) {
    const users = await this.json<{ id: number }[]>([`users?username=${encodeURIComponent(username)}`])
    const user = users[0]
    if (!user) throw new Error(`GitLab user ${username} not found`)
    return user.id
  }

  async setPriority(id: string, priority: number) {
    await this.replaceLabel(id, PRIORITY_LABEL, PRIORITY_LABEL + priority)
  }

  async updateBody(id: string, body: string) {
    const current = await this.json<{ description: string | null }>([`${this.issuePath(id)}`])
    const blockers = current.description?.match(BLOCKED_BY)?.[0]
    const keep = blockers && !BLOCKED_BY.test(body) ? `${body}\n\n${blockers}` : body
    await this.json(['-X', 'PUT', `${this.issuePath(id)}`, '-f', `description=${keep}`])
  }

  async closeTask(id: string) {
    await this.json(['-X', 'PUT', `${this.issuePath(id)}`, '-f', 'state_event=close'])
  }

  async deleteTask(id: string) {
    await this.json(['-X', 'DELETE', this.issuePath(id)])
  }

  async listComments(id: string) {
    const notes = await this.pages<Note>(`${this.issuePath(id)}/notes?sort=asc&order_by=created_at`)
    return notes.filter((note) => !note.system).map((note) => toComment(id, note))
  }

  async addComment(id: string, body: string) {
    return toComment(id, await this.json<Note>(['-X', 'POST', `${this.issuePath(id)}/notes`, '-f', `body=${body}`]))
  }

  async updateComment(commentId: string, body: string) {
    const at = commentId.lastIndexOf(':')
    await this.json(['-X', 'PUT', `${this.issuePath(commentId.slice(0, at))}/notes/${commentId.slice(at + 1)}`, '-f', `body=${body}`])
  }

  async addBlocker(id: string, blockerId: string) {
    const blocker = this.split(blockerId)
    const project = await this.json<{ id: number }>([`projects/${encodeURIComponent(blocker.project)}`])
    const linked = await this.call(['-X', 'POST', `${this.issuePath(id)}/links`, '-f', `target_project_id=${project.id}`, '-f', `target_issue_iid=${blocker.iid}`, '-f', 'link_type=is_blocked_by'])
    if (linked.code === 0 || linked.status === 409) return
    if (![403, 404, 400].includes(linked.status)) this.fail(linked, 'issue link')
    const current = await this.json<{ description: string | null }>([`${this.issuePath(id)}`])
    const description = current.description ?? ''
    const existing: string[] = description.match(BLOCKED_BY)?.[1]?.match(/[\w./-]*#\d+/g) ?? []
    const mark = this.split(id).project === blocker.project ? `#${blocker.iid}` : blockerId
    if (existing.includes(mark)) return
    const line = `Blocked by: ${[...existing, mark].join(', ')}`
    const updated = BLOCKED_BY.test(description) ? description.replace(BLOCKED_BY, line) : `${description}${description ? '\n\n' : ''}${line}`
    await this.json(['-X', 'PUT', `${this.issuePath(id)}`, '-f', `description=${updated}`])
  }

  async claim(id: string) {
    const result = await this.call(['-X', 'POST', `${this.api}/repository/branches`, '-f', `branch=${LOCK_PREFIX}${taskSlug(id)}`, '-f', `ref=${await this.baseBranch()}`])
    if (result.status === 400 && /already exists/i.test(result.stderr + result.stdout)) return false
    if (result.code !== 0) this.fail(result, 'claim')
    return true
  }

  async release(id: string) {
    const result = await this.call(['-X', 'DELETE', `${this.api}/repository/branches/${encodeURIComponent(LOCK_PREFIX + taskSlug(id))}`])
    if (result.code !== 0 && result.status !== 404) this.fail(result, 'release')
  }

  async openPullRequest(id: string, title: string, body: string, repo?: string, draft = false) {
    const api = this.repoApi(repo)
    const existing = await this.pullRequest(id, repo)
    if (existing?.state === 'open') return existing
    await this.json(['-X', 'POST', `${api}/merge_requests`, '-f', `source_branch=conveyor/${taskSlug(id)}`, '-f', `target_branch=${await this.baseBranch(repo)}`, '-f', `title=${draft ? `Draft: ${title}` : title}`, '-f', `description=${body}`, '-f', `assignee_id=${await this.userId(await this.user())}`])
    const opened = await this.pullRequest(id, repo)
    if (!opened) throw new Error(`merge request for task ${id} not found after creation`)
    return opened
  }

  async readyPullRequest(id: string, title: string, body: string, repo?: string) {
    const pull = await this.pullRequest(id, repo)
    if (!pull || pull.state !== 'open') throw new Error(`no open merge request for task ${id}${repo ? ` in ${repo}` : ''}`)
    await this.json(['-X', 'PUT', `${this.repoApi(repo)}/merge_requests/${pull.number}`, '-f', `title=${title}`, '-f', `description=${body}`])
  }

  async pullRequest(id: string, repo?: string): Promise<PullRequest | undefined> {
    const api = this.repoApi(repo)
    const listed = await this.json<MergeRequest[]>([`${api}/merge_requests?source_branch=${encodeURIComponent(`conveyor/${taskSlug(id)}`)}&state=all&order_by=created_at&sort=desc`])
    const first = listed.find((request) => request.source_project_id === request.target_project_id)
    if (!first) return undefined
    const request = await this.json<MergeRequest>([`${api}/merge_requests/${first.iid}`])
    const approvals = await this.json<{ approved_by: { user: { username: string } }[] }>([`${api}/merge_requests/${first.iid}/approvals`])
    const reviewers = await this.json<{ user: { username: string }; state: string; updated_at?: string; created_at?: string }[]>([
      `${api}/merge_requests/${first.iid}/reviewers`,
    ])
    const all = await this.pages<Note>(`${api}/merge_requests/${first.iid}/notes?sort=asc&order_by=created_at`)
    const notes = all.filter((note) => !note.system)
    const approvedAt = new Map(all.filter((note) => note.system && APPROVED.test(note.body)).map((note) => [note.author.username, note.created_at]))
    const headAt = all.filter((note) => note.system && /^added \d+ (new )?commits?\b/.test(note.body)).at(-1)?.created_at
    const now = new Date().toISOString()
    return {
      number: String(request.iid),
      url: request.web_url,
      headSha: request.sha,
      state: request.state === 'opened' || request.state === 'locked' ? 'open' : request.state,
      checks: await this.pipelineChecks(api, request.head_pipeline),
      mergeable: mergeable(request.detailed_merge_status),
      ...(request.draft ? { draft: true } : {}),
      ...(headAt ? { headAt } : {}),
      ...(BLOCKED[request.detailed_merge_status] ? { blocked: BLOCKED[request.detailed_merge_status] } : {}),
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

  async mergePullRequest(id: string, method: MergeMethod, sha: string, repo?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const api = this.repoApi(repo)
    const pull = await this.pullRequest(id, repo)
    if (!pull || pull.state !== 'open') return { ok: false, error: 'no open merge request' }
    const result = await this.call(['-X', 'PUT', `${api}/merge_requests/${pull.number}/merge`, '-f', `sha=${sha}`, ...(method === 'squash' ? ['-F', 'squash=true'] : [])])
    return result.code === 0 ? { ok: true } : { ok: false, error: (result.stderr || result.stdout).trim() || `merge failed with HTTP ${result.status}` }
  }

  async commentPullRequest(id: string, body: string, repo?: string) {
    const api = this.repoApi(repo)
    const pull = await this.pullRequest(id, repo)
    if (!pull) throw new Error(`task ${id} has no merge request`)
    await this.json(['-X', 'POST', `${api}/merge_requests/${pull.number}/notes`, '-f', `body=${body}`])
  }

  async mergeCommit(id: string, repo?: string) {
    const api = this.repoApi(repo)
    const listed = await this.json<{ merge_commit_sha: string | null; squash_commit_sha: string | null; source_project_id: number; target_project_id: number }[]>([
      `${api}/merge_requests?source_branch=${encodeURIComponent(`conveyor/${taskSlug(id)}`)}&state=merged&order_by=updated_at&sort=desc`,
    ])
    const merged = listed.find((request) => request.source_project_id === request.target_project_id)
    return merged?.merge_commit_sha ?? merged?.squash_commit_sha ?? undefined
  }

  async linkedPulls(id: string): Promise<LinkedPull[]> {
    const related = await this.json<{ iid: number; web_url: string; source_branch: string; state: string; draft?: boolean; source_project_id: number; target_project_id: number; author: { username: string } }[]>([`${this.issuePath(id)}/related_merge_requests`])
    return related
      .filter((request) => request.state === 'opened' && request.source_project_id === request.target_project_id)
      .map((request) => ({ number: String(request.iid), url: request.web_url, branch: request.source_branch, draft: request.draft ?? false, author: request.author.username }))
  }

  async baseHead(repo?: string) {
    const api = this.repoApi(repo)
    const branch = await this.json<{ commit: { id: string } }>([`${api}/repository/branches/${encodeURIComponent(await this.baseBranch(repo))}`])
    return branch.commit.id
  }

  async failedChecks(sha: string, repo?: string) {
    const api = this.repoApi(repo)
    const commit = await this.json<{ last_pipeline: { id: number; status: string } | null }>([`${api}/repository/commits/${sha}`])
    if (!commit.last_pipeline || (await this.pipelineChecks(api, commit.last_pipeline)) !== 'failure') return []
    const jobs = await this.pipelineJobs(api, commit.last_pipeline.id)
    return jobs.filter((job) => ['failed', 'canceled'].includes(job.status) && !job.allow_failure && !ignoredCheck(job.name, this.options.ignoreChecks ?? [])).map((job) => job.name)
  }

  async passedChecks(sha: string, repo?: string) {
    const api = this.repoApi(repo)
    const commit = await this.json<{ last_pipeline: { id: number } | null }>([`${api}/repository/commits/${sha}`])
    if (!commit.last_pipeline) return []
    const jobs = await this.pipelineJobs(api, commit.last_pipeline.id)
    return jobs.filter((job) => job.status === 'success').map((job) => job.name).filter((name) => !ignoredCheck(name, this.options.ignoreChecks ?? []))
  }

  async commitChecks(sha: string, repo?: string) {
    const api = this.repoApi(repo)
    const commit = await this.json<{ last_pipeline: { id: number; status: string } | null }>([`${api}/repository/commits/${sha}`])
    return this.pipelineChecks(api, commit.last_pipeline)
  }

  private async pipelineJobs(api: string, id: number) {
    type Job = { name: string; status: string; allow_failure?: boolean }
    return [...(await this.pages<Job>(`${api}/pipelines/${id}/jobs`)), ...(await this.pages<Job>(`${api}/pipelines/${id}/bridges`))]
  }

  private async pipelineChecks(api: string, pipeline: { id: number; status: string } | null): Promise<PullRequest['checks']> {
    const ignore = this.options.ignoreChecks ?? []
    if (!pipeline || ignore.length === 0 || pipeline.status === 'success') return checks(pipeline?.status)
    const jobs = (await this.pipelineJobs(api, pipeline.id)).filter((job) => !ignoredCheck(job.name, ignore))
    if (jobs.some((job) => ['failed', 'canceled', 'canceling'].includes(job.status) && !job.allow_failure)) return 'failure'
    if (jobs.some((job) => ['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'scheduled'].includes(job.status) || (job.status === 'manual' && job.allow_failure === false))) return 'pending'
    return jobs.some((job) => job.status === 'success') ? 'success' : 'none'
  }

  async closePullRequest(id: string, repo?: string) {
    const api = this.repoApi(repo)
    const pull = await this.pullRequest(id, repo)
    if (pull?.state === 'open') await this.json(['-X', 'PUT', `${api}/merge_requests/${pull.number}`, '-f', 'state_event=close'])
  }

  private async toTasks(issues: GraphIssue[]): Promise<Task[]> {
    const blockers = new Map(issues.map((issue) => [issue, this.fallbackBlockers(issue)]))
    const byProject = new Map<string, Set<string>>()
    for (const list of blockers.values()) for (const blocker of list) byProject.set(blocker.project, (byProject.get(blocker.project) ?? new Set()).add(blocker.iid))
    const open = new Set<string>()
    for (const [project, iids] of byProject) {
      const states = await this.graphql<{ project: { issues: { nodes: { iid: string; state: string }[] } } | null }>(
        `query { project(fullPath: ${JSON.stringify(project)}) { issues(iids: ${JSON.stringify([...iids])}, first: 100) { nodes { iid state } } } }`,
      )
      for (const node of states.project?.issues.nodes ?? []) if (node.state === 'opened') open.add(`${project}#${node.iid}`)
    }
    return issues.map((issue) => ({
      id: this.idOf(issue.reference),
      title: issue.title,
      body: (issue.description ?? '').replace(BLOCKED_BY, '').trim(),
      author: issue.author.username,
      url: issue.webUrl,
      labels: issue.labels.nodes.map((node) => node.title),
      assignees: issue.assignees.nodes.map((node) => node.username),
      openBlockers: (issue.blockedByCount ?? 0) + (blockers.get(issue) ?? []).filter((blocker) => open.has(`${blocker.project}#${blocker.iid}`)).length,
      closed: issue.state === 'closed',
      createdAt: issue.createdAt,
      ...labelsToTask(issue.labels.nodes.map((node) => node.title)),
    }))
  }

  private fallbackBlockers(issue: GraphIssue) {
    const home = issue.reference.slice(0, issue.reference.lastIndexOf('#'))
    const group = this.options.group
    return [...(issue.description?.match(BLOCKED_BY)?.[1]?.matchAll(/([\w./-]*)#(\d+)/g) ?? [])].map((match) => {
      const path = match[1] ?? ''
      return { project: !path ? home : group && !path.startsWith(`${group}/`) ? `${group}/${path}` : path, iid: match[2] ?? '' }
    })
  }

  private async replaceLabel(id: string, prefix: string, label: string | undefined) {
    const issue = await this.json<{ labels: string[] }>([`${this.issuePath(id)}`])
    const remove = issue.labels.filter((name) => name.startsWith(prefix) && name !== label)
    const add = label && !issue.labels.includes(label) ? [label] : []
    if (remove.length === 0 && add.length === 0) return
    await this.json([
      '-X', 'PUT', `${this.issuePath(id)}`,
      ...(add.length ? ['-f', `add_labels=${add.join(',')}`] : []),
      ...(remove.length ? ['-f', `remove_labels=${remove.join(',')}`] : []),
    ])
  }

  async baseBranch(repo?: string) {
    if (!repo) {
      this.defaultBranch ??= this.options.baseBranch ?? (await this.json<{ default_branch: string }>([this.api])).default_branch
      return this.defaultBranch
    }
    const known = this.repoBranches.get(repo) ?? this.options.repos?.base[repo] ?? (await this.json<{ default_branch: string }>([this.repoApi(repo)])).default_branch
    this.repoBranches.set(repo, known)
    return known
  }

  private repoApi(repo?: string) {
    if (!repo) return this.api
    if (!this.options.repos) throw new Error(`task repositories need repos in the settings (${repo})`)
    return `projects/${encodeURIComponent(this.options.repos.paths?.[repo] ?? `${this.options.repos.group}/${repo}`)}`
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
    const detail = (result.stderr || result.stdout).trim().slice(0, 500)
    const hint = result.status === 0 ? ' Check that glab is installed and signed in to this GitLab host: glab auth status.' : ''
    throw new Error(`glab api ${what} failed (HTTP ${result.status}): ${detail || 'no answer from glab'}.${hint}`)
  }
}

function checks(status: string | undefined): PullRequest['checks'] {
  if (!status) return 'none'
  if (status === 'success') return 'success'
  if (['failed', 'canceled', 'canceling'].includes(status)) return 'failure'
  if (['skipped', 'manual'].includes(status)) return 'none'
  return 'pending'
}

const BLOCKED: Record<string, string> = {
  not_approved: 'GitLab approval rules are not met yet',
  discussions_not_resolved: 'GitLab requires every thread of the merge request to be resolved',
  requested_changes: 'a reviewer requested changes in GitLab',
  blocked_status: 'another merge request blocks it in GitLab',
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
