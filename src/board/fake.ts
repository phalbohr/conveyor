import { OWNER_LABEL, STATE_LABEL, labelsToTask, type Board, type Comment, type Task, type TaskState } from './board.js'

type Issue = {
  title: string
  body: string
  labels: string[]
  assignees: string[]
  closed: boolean
  createdAt: string
  blockers: Set<string>
}

export class FakeBoard implements Board {
  private readonly issues = new Map<string, Issue>()
  private readonly comments = new Map<string, Comment & { taskId: string }>()
  private readonly locks = new Set<string>()
  private nextId = 1

  constructor(
    private readonly login: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async user() {
    return this.login
  }

  async createTask(title: string, body: string, state?: TaskState) {
    const id = String(this.nextId++)
    this.issues.set(id, {
      title,
      body,
      labels: state ? [STATE_LABEL + state] : [],
      assignees: [],
      closed: false,
      createdAt: this.now().toISOString(),
      blockers: new Set(),
    })
    return this.toTask(id)
  }

  async listTasks() {
    return [...this.issues.keys()].map((id) => this.toTask(id)).filter((task) => !task.closed && task.state)
  }

  async getTask(id: string) {
    return this.issues.has(id) ? this.toTask(id) : undefined
  }

  async setState(id: string, state: TaskState) {
    this.replaceLabel(id, STATE_LABEL, STATE_LABEL + state)
  }

  async setOwner(id: string, owner: string | undefined) {
    this.replaceLabel(id, OWNER_LABEL, owner ? OWNER_LABEL + owner : undefined)
  }

  async updateBody(id: string, body: string) {
    this.issue(id).body = body
  }

  async closeTask(id: string) {
    this.issue(id).closed = true
  }

  async listComments(id: string) {
    return [...this.comments.values()].filter((comment) => comment.taskId === id).map(({ taskId, ...comment }) => comment)
  }

  async addComment(id: string, body: string) {
    this.issue(id)
    const time = this.now().toISOString()
    const comment = { id: `c${this.comments.size + 1}`, author: this.login, body, createdAt: time, updatedAt: time }
    this.comments.set(comment.id, { ...comment, taskId: id })
    return comment
  }

  async updateComment(commentId: string, body: string) {
    const comment = this.comments.get(commentId)
    if (!comment) throw new Error(`comment ${commentId} not found`)
    Object.assign(comment, { body, updatedAt: this.now().toISOString() })
  }

  async addBlocker(id: string, blockerId: string) {
    this.issue(blockerId)
    this.issue(id).blockers.add(blockerId)
  }

  async claim(id: string) {
    if (this.locks.has(id)) return false
    this.locks.add(id)
    return true
  }

  async release(id: string) {
    this.locks.delete(id)
  }

  private issue(id: string): Issue {
    const issue = this.issues.get(id)
    if (!issue) throw new Error(`task ${id} not found`)
    return issue
  }

  private replaceLabel(id: string, prefix: string, label: string | undefined) {
    const issue = this.issue(id)
    issue.labels = [...issue.labels.filter((existing) => !existing.startsWith(prefix)), ...(label ? [label] : [])]
  }

  private toTask(id: string): Task {
    const issue = this.issue(id)
    return {
      id,
      title: issue.title,
      body: issue.body,
      assignees: [...issue.assignees],
      openBlockers: [...issue.blockers].filter((blocker) => !this.issue(blocker).closed).length,
      closed: issue.closed,
      createdAt: issue.createdAt,
      ...labelsToTask(issue.labels),
    }
  }
}
