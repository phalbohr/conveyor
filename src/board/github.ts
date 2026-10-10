import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Run } from '../cli.js'
import {
  boardLabels,
  CONVEYOR_PREFIXES,
  FORM_LABEL,
  labelsToTask,
  onBoard,
  OWNER_LABEL,
  PART_LABEL,
  PRIORITY_LABEL,
  STAGE_LABEL,
  STATE_LABEL,
  TASK_STATES,
  taskLabels,
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
} from './board.js'

type Issue = {
  number: number
  id: number
  title: string
  body: string | null
  html_url: string
  user: { login: string }
  state: 'open' | 'closed'
  labels: { name: string }[]
  assignees: { login: string }[]
  created_at: string
  pull_request?: unknown
  issue_dependencies_summary?: { blocked_by: number }
}

type GitHubComment = { id: number; user: { login: string }; body: string; created_at: string; updated_at: string }

type Check = { status?: string; conclusion?: string; state?: string }

type GitHubPull = {
  number: number
  url: string
  headRefOid: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  statusCheckRollup: Check[] | null
  reviews: { state: string; body: string; submittedAt: string; author: { login: string } | null }[]
  comments: { body: string; createdAt: string; author: { login: string } | null }[]
}

type ProjectField = { id: string; name: string; type: string; options?: { id: string; name: string }[] }
type ProjectMirror = { projectId: string; fieldId: string; options: Map<string, string> }

export type GitHubBoardOptions = { projectNumber?: number; warn?: (message: string) => void }

const PROJECT_FIELD = 'Conveyor'
const PULL_FIELDS = 'number,url,headRefOid,state,mergeable,statusCheckRollup,reviews,comments'

const LOCK_PREFIX = 'conveyor-lock/'
const WRITE_PERMISSIONS = ['admin', 'write']

export class GitHubBoard implements Board {
  private readonly repo: string
  private login?: string
  private defaultBranch?: string
  private mirror?: ProjectMirror

  constructor(
    private readonly project: string,
    private readonly run: Run,
    private readonly options: GitHubBoardOptions = {},
  ) {
    this.repo = `repos/${project}`
  }

  async user() {
    this.login ??= (await this.api<{ login: string }>(['user'])).login
    return this.login
  }

  async prepare(stages: string[]) {
    for (const label of boardLabels(stages)) {
      const result = await this.call(['-X', 'POST', `${this.repo}/labels`, '-f', `name=${label.name}`, '-f', `color=${label.color}`])
      if (result.status !== 422) this.parse(result)
    }
    if (!this.options.projectNumber) return
    const mirror = await this.projectMirror(this.options.projectNumber, true)
    await this.addMissingOptions(mirror.fieldId)
  }

  private async addMissingOptions(fieldId: string) {
    type Option = { id: string; name: string; color: string; description: string }
    const found = await this.graphql<{ node: { options: Option[] } }>(
      'query($id: ID!) { node(id: $id) { ... on ProjectV2SingleSelectField { options { id name color description } } } }',
      { id: fieldId },
    )
    const options = found.node.options
    const missing = TASK_STATES.filter((state) => !options.some((option) => option.name === state))
    if (missing.length === 0) return
    await this.graphql(
      'mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }',
      { input: { fieldId, singleSelectOptions: [...options, ...missing.map((name) => ({ name, color: 'GRAY', description: '' }))] } },
    )
    this.mirror = undefined
  }

  private async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'conveyor-graphql-'))
    try {
      const body = join(dir, 'body.json')
      writeFileSync(body, JSON.stringify({ query, variables }))
      const response = JSON.parse(await this.gh(['api', 'graphql', '--input', body])) as { data?: T; errors?: { message: string }[] }
      if (!response.data || response.errors?.length) throw new Error(`GitHub GraphQL failed: ${response.errors?.map((error) => error.message).join('; ') ?? 'no data'}`)
      return response.data
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async inspect(): Promise<BoardInspection> {
    const labels = (await this.api<{ name: string }[][]>(['--paginate', '--slurp', `${this.repo}/labels?per_page=100`])).flat().map((label) => label.name)
    const pages = await this.api<Issue[][]>(['--paginate', '--slurp', `${this.repo}/issues?state=open&per_page=100`])
    const issues = pages
      .flat()
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({ id: String(issue.number), title: issue.title, labels: issue.labels.map(({ name }) => name) }))
      .filter((issue) => issue.labels.some((label) => CONVEYOR_PREFIXES.some((prefix) => label.startsWith(prefix))))
    const number = this.options.projectNumber
    if (!number) return { labels, issues }
    const fields = JSON.parse(await this.gh(['project', 'field-list', String(number), '--owner', this.owner(), '--format', 'json'])) as { fields: ProjectField[] }
    const field = fields.fields.find((candidate) => candidate.name === PROJECT_FIELD)
    return { labels, issues, field: field ? { options: (field.options ?? []).map((option) => option.name) } : 'missing' }
  }

  async boardUrl() {
    const number = this.options.projectNumber
    if (!number) return `https://github.com/${this.project}/issues`
    const project = JSON.parse(await this.gh(['project', 'view', String(number), '--owner', this.owner(), '--format', 'json'])) as { url: string }
    return project.url
  }

  async canWrite(user: string) {
    if (!user) return false
    const result = await this.call([`${this.repo}/collaborators/${encodeURIComponent(user)}/permission`])
    if (result.status === 404) return false
    return WRITE_PERMISSIONS.includes(this.parse<{ permission: string }>(result).permission)
  }

  async createTask(title: string, body: string, labels: TaskLabels = {}) {
    const flags = taskLabels(labels).flatMap((label) => ['-f', `labels[]=${label}`])
    const task = toTask(await this.api<Issue>(['-X', 'POST', `${this.repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`, ...flags]))
    if (labels.state) await this.mirrorState(task.id, labels.state)
    return task
  }

  async listTasks() {
    const pages = await this.api<Issue[][]>(['--paginate', '--slurp', `${this.repo}/issues?state=open&per_page=100`])
    return pages
      .flat()
      .filter((issue) => !issue.pull_request)
      .map(toTask)
      .filter(onBoard)
  }

  async getTask(id: string) {
    const result = await this.call([`${this.repo}/issues/${id}`])
    if (result.status === 404) return undefined
    return toTask(this.parse<Issue>(result))
  }

  async setState(id: string, state: TaskState) {
    await this.replaceLabel(id, STATE_LABEL, STATE_LABEL + state)
    await this.mirrorState(id, state)
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

  async setOwner(id: string, owner: string | undefined) {
    await this.replaceLabel(id, OWNER_LABEL, owner ? OWNER_LABEL + owner : undefined)
  }

  async updateBody(id: string, body: string) {
    await this.api(['-X', 'PATCH', `${this.repo}/issues/${id}`, '-f', `body=${body}`])
  }

  async closeTask(id: string) {
    await this.api(['-X', 'PATCH', `${this.repo}/issues/${id}`, '-f', 'state=closed'])
  }

  async listComments(id: string) {
    const pages = await this.api<GitHubComment[][]>(['--paginate', '--slurp', `${this.repo}/issues/${id}/comments?per_page=100`])
    return pages.flat().map(toComment)
  }

  async addComment(id: string, body: string) {
    return toComment(await this.api<GitHubComment>(['-X', 'POST', `${this.repo}/issues/${id}/comments`, '-f', `body=${body}`]))
  }

  async updateComment(commentId: string, body: string) {
    await this.api(['-X', 'PATCH', `${this.repo}/issues/comments/${commentId}`, '-f', `body=${body}`])
  }

  async addBlocker(id: string, blockerId: string) {
    const blocker = await this.api<Issue>([`${this.repo}/issues/${blockerId}`])
    await this.api(['-X', 'POST', `${this.repo}/issues/${id}/dependencies/blocked_by`, '-F', `issue_id=${blocker.id}`])
  }

  async claim(id: string) {
    const head = await this.api<{ object: { sha: string } }>([`${this.repo}/git/ref/heads/${await this.branch()}`])
    const result = await this.call(['-X', 'POST', `${this.repo}/git/refs`, '-f', `ref=refs/heads/${LOCK_PREFIX}${id}`, '-f', `sha=${head.object.sha}`])
    if (result.status === 422) return false
    this.parse(result)
    return true
  }

  async release(id: string) {
    const result = await this.call(['-X', 'DELETE', `${this.repo}/git/refs/heads/${LOCK_PREFIX}${id}`])
    if (result.status !== 404 && result.status !== 422) this.parse(result)
  }

  async setPriority(id: string, priority: number) {
    await this.replaceLabel(id, PRIORITY_LABEL, PRIORITY_LABEL + priority)
  }

  async openPullRequest(id: string, title: string, body: string) {
    const existing = await this.pullRequest(id)
    if (existing?.state === 'open') return existing
    const base = await this.branch()
    await this.gh(['pr', 'create', '-R', this.project, '--head', `conveyor/${id}`, '--base', base, '--title', title, '--body', body])
    const opened = await this.pullRequest(id)
    if (!opened) throw new Error(`pull request for task ${id} not found after creation`)
    return opened
  }

  async pullRequest(id: string) {
    const output = await this.gh(['pr', 'list', '-R', this.project, '--head', `conveyor/${id}`, '--state', 'all', '--limit', '1', '--json', PULL_FIELDS])
    const pull = (JSON.parse(output) as GitHubPull[])[0]
    if (!pull) return undefined
    const inline = await this.api<{ path: string; line: number | null; body: string; user: { login: string } | null }[][]>([
      '--paginate',
      '--slurp',
      `${this.repo}/pulls/${pull.number}/comments?per_page=100`,
    ])
    return toPull(
      pull,
      inline.flat().map((comment) => ({ author: comment.user?.login ?? '', body: `${comment.path}${comment.line ? `:${comment.line}` : ''}: ${comment.body}` })),
    )
  }

  async mergePullRequest(id: string, method: MergeMethod, sha: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const pull = await this.pullRequest(id)
    if (!pull || pull.state !== 'open') return { ok: false, error: 'no open pull request' }
    const result = await this.run('gh', ['pr', 'merge', pull.number, '-R', this.project, `--${method}`, '--match-head-commit', sha])
    return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() || `gh pr merge exited with code ${result.code}` }
  }

  async commentPullRequest(id: string, body: string) {
    const pull = await this.pullRequest(id)
    if (!pull) throw new Error(`task ${id} has no pull request`)
    await this.gh(['pr', 'comment', pull.number, '-R', this.project, '--body', body])
  }

  async closePullRequest(id: string) {
    const pull = await this.pullRequest(id)
    if (pull?.state === 'open') await this.gh(['pr', 'close', pull.number, '-R', this.project])
  }

  async linkedProjects(): Promise<LinkedProject[]> {
    const [owner, name] = this.project.split('/')
    const found = await this.graphql<{ repository: { projectsV2: { nodes: LinkedProject[] } } }>(
      'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { projectsV2(first: 20) { nodes { number title url } } } }',
      { owner, name },
    )
    return found.repository.projectsV2.nodes
  }

  async createProject(title: string): Promise<LinkedProject> {
    const created = JSON.parse(await this.gh(['project', 'create', '--owner', this.owner(), '--title', title, '--format', 'json'])) as LinkedProject
    await this.gh(['project', 'link', String(created.number), '--owner', this.owner(), '--repo', this.project])
    return { number: created.number, title: created.title ?? title, url: created.url }
  }

  async syncMirror(tasks: Task[]) {
    const number = this.options.projectNumber
    if (!number) return 0
    const mirror = await this.projectMirror(number)
    const listed = JSON.parse(await this.gh(['project', 'item-list', String(number), '--owner', this.owner(), '--format', 'json', '--limit', '10000'])) as {
      items: { content?: { number?: number; repository?: string }; conveyor?: string }[]
    }
    const current = new Map(listed.items.filter((item) => item.content?.repository === this.project).map((item) => [String(item.content?.number), item.conveyor]))
    let synced = 0
    for (const task of tasks) {
      if (!task.state || task.closed || current.get(task.id) === task.state || !mirror.options.has(task.state)) continue
      await this.mirrorState(task.id, task.state)
      synced++
    }
    return synced
  }

  private async mirrorState(id: string, state: TaskState) {
    const number = this.options.projectNumber
    if (!number) return
    try {
      const mirror = await this.projectMirror(number)
      const option = mirror.options.get(state)
      if (!option) throw new Error(`the ${PROJECT_FIELD} field has no option ${state}`)
      const item = JSON.parse(
        await this.gh(['project', 'item-add', String(number), '--owner', this.owner(), '--url', `https://github.com/${this.project}/issues/${id}`, '--format', 'json']),
      ) as { id: string }
      await this.gh(['project', 'item-edit', '--id', item.id, '--project-id', mirror.projectId, '--field-id', mirror.fieldId, '--single-select-option-id', option])
    } catch (error) {
      this.options.warn?.(`project ${number}: task ${id} → ${state} not mirrored: ${(error as Error).message}`)
    }
  }

  private async projectMirror(number: number, create = false): Promise<ProjectMirror> {
    if (this.mirror) return this.mirror
    const owner = this.owner()
    const project = JSON.parse(await this.gh(['project', 'view', String(number), '--owner', owner, '--format', 'json'])) as { id: string }
    const fields = async () =>
      (JSON.parse(await this.gh(['project', 'field-list', String(number), '--owner', owner, '--format', 'json'])) as { fields: ProjectField[] }).fields
    let field = (await fields()).find((candidate) => candidate.name === PROJECT_FIELD)
    if (!field && !create) throw new Error(`the project has no ${PROJECT_FIELD} field; run \`conveyor board update\``)
    if (!field) {
      await this.gh([
        'project', 'field-create', String(number), '--owner', owner,
        '--name', PROJECT_FIELD, '--data-type', 'SINGLE_SELECT', '--single-select-options', TASK_STATES.join(','),
      ])
      field = (await fields()).find((candidate) => candidate.name === PROJECT_FIELD)
    }
    if (!field?.options) throw new Error(`the project has no single-select field ${PROJECT_FIELD}`)
    this.mirror = { projectId: project.id, fieldId: field.id, options: new Map(field.options.map((option) => [option.name, option.id])) }
    return this.mirror
  }

  private owner() {
    return this.project.split('/')[0] ?? this.project
  }

  private async branch() {
    this.defaultBranch ??= (await this.api<{ default_branch: string }>([this.repo])).default_branch
    return this.defaultBranch
  }

  private async gh(args: string[]) {
    const result = await this.run('gh', args)
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`)
    return result.stdout
  }

  private async replaceLabel(id: string, prefix: string, label: string | undefined) {
    const issue = await this.api<Issue>([`${this.repo}/issues/${id}`])
    for (const { name } of issue.labels) {
      if (name.startsWith(prefix) && name !== label) {
        await this.api(['-X', 'DELETE', `${this.repo}/issues/${id}/labels/${encodeURIComponent(name)}`])
      }
    }
    if (label && !issue.labels.some(({ name }) => name === label)) {
      await this.api(['-X', 'POST', `${this.repo}/issues/${id}/labels`, '-f', `labels[]=${label}`])
    }
  }

  private async call(args: string[]) {
    const result = await this.run('gh', ['api', ...args])
    const status = Number(result.stderr.match(/\(HTTP (\d{3})\)/)?.[1] ?? (result.code === 0 ? 200 : 0))
    return { ...result, status, args }
  }

  private parse<T>(result: Awaited<ReturnType<GitHubBoard['call']>>): T {
    if (result.code !== 0) throw new Error(`gh api ${result.args.join(' ')} failed: ${result.stderr.trim()}`)
    return (result.stdout.trim() ? JSON.parse(result.stdout) : undefined) as T
  }

  private async api<T = unknown>(args: string[]): Promise<T> {
    return this.parse<T>(await this.call(args))
  }
}

function toTask(issue: Issue): Task {
  return {
    id: String(issue.number),
    title: issue.title,
    body: issue.body ?? '',
    author: issue.user.login,
    url: issue.html_url,
    labels: issue.labels.map(({ name }) => name),
    assignees: issue.assignees.map(({ login }) => login),
    openBlockers: issue.issue_dependencies_summary?.blocked_by ?? 0,
    closed: issue.state === 'closed',
    createdAt: issue.created_at,
    ...labelsToTask(issue.labels.map(({ name }) => name)),
  }
}

function toPull(pull: GitHubPull, inline: PullRequest['feedback']): PullRequest {
  const checks = pull.statusCheckRollup ?? []
  const failed = checks.some((check) =>
    ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(check.conclusion ?? check.state ?? ''),
  )
  const pending = checks.some((check) => (check.status && check.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(check.state ?? ''))
  return {
    number: String(pull.number),
    url: pull.url,
    headSha: pull.headRefOid,
    state: pull.state === 'OPEN' ? 'open' : pull.state === 'MERGED' ? 'merged' : 'closed',
    checks: checks.length === 0 ? 'none' : failed ? 'failure' : pending ? 'pending' : 'success',
    mergeable: pull.mergeable === 'MERGEABLE' ? 'yes' : pull.mergeable === 'CONFLICTING' ? 'no' : 'unknown',
    feedback: inline,
    reviews: pull.reviews.map((review) => ({
      author: review.author?.login ?? '',
      state: review.state === 'APPROVED' ? 'approved' : review.state === 'CHANGES_REQUESTED' ? 'changes_requested' : review.state === 'DISMISSED' ? 'dismissed' : 'commented',
      body: review.body,
      submittedAt: review.submittedAt,
    })),
    comments: pull.comments.map((comment) => ({ author: comment.author?.login ?? '', body: comment.body, createdAt: comment.createdAt })),
  }
}

function toComment(comment: GitHubComment): Comment {
  return {
    id: String(comment.id),
    author: comment.user.login,
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  }
}
