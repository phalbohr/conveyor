import type { Run } from '../cli.js'
import { OWNER_LABEL, STATE_LABEL, labelsToTask, type Board, type Comment, type Task, type TaskState } from './board.js'

type Issue = {
  number: number
  id: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: { name: string }[]
  assignees: { login: string }[]
  created_at: string
  pull_request?: unknown
  issue_dependencies_summary?: { blocked_by: number }
}

type GitHubComment = { id: number; user: { login: string }; body: string; created_at: string; updated_at: string }

const LOCK_PREFIX = 'conveyor-lock/'

export class GitHubBoard implements Board {
  private readonly repo: string
  private login?: string

  constructor(
    project: string,
    private readonly run: Run,
  ) {
    this.repo = `repos/${project}`
  }

  async user() {
    this.login ??= (await this.api<{ login: string }>(['user'])).login
    return this.login
  }

  async createTask(title: string, body: string, state?: TaskState) {
    const labels = state ? ['-f', `labels[]=${STATE_LABEL}${state}`] : []
    return toTask(await this.api<Issue>(['-X', 'POST', `${this.repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`, ...labels]))
  }

  async listTasks() {
    const pages = await this.api<Issue[][]>(['--paginate', '--slurp', `${this.repo}/issues?state=open&per_page=100`])
    return pages
      .flat()
      .filter((issue) => !issue.pull_request)
      .map(toTask)
      .filter((task) => task.state)
  }

  async getTask(id: string) {
    const result = await this.call([`${this.repo}/issues/${id}`])
    if (result.status === 404) return undefined
    return toTask(this.parse<Issue>(result))
  }

  async setState(id: string, state: TaskState) {
    await this.replaceLabel(id, STATE_LABEL, STATE_LABEL + state)
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
    const { default_branch } = await this.api<{ default_branch: string }>([this.repo])
    const head = await this.api<{ object: { sha: string } }>([`${this.repo}/git/ref/heads/${default_branch}`])
    const result = await this.call(['-X', 'POST', `${this.repo}/git/refs`, '-f', `ref=refs/heads/${LOCK_PREFIX}${id}`, '-f', `sha=${head.object.sha}`])
    if (result.status === 422) return false
    this.parse(result)
    return true
  }

  async release(id: string) {
    const result = await this.call(['-X', 'DELETE', `${this.repo}/git/refs/heads/${LOCK_PREFIX}${id}`])
    if (result.status !== 404 && result.status !== 422) this.parse(result)
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
    assignees: issue.assignees.map(({ login }) => login),
    openBlockers: issue.issue_dependencies_summary?.blocked_by ?? 0,
    closed: issue.state === 'closed',
    createdAt: issue.created_at,
    ...labelsToTask(issue.labels.map(({ name }) => name)),
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
