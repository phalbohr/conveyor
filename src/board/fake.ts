import {
  boardLabels,
  FORM_LABEL,
  labelsToTask,
  onBoard,
  OWNER_LABEL,
  PART_LABEL,
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

type Issue = {
  title: string
  body: string
  author: string
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
  private readonly pulls = new Map<string, PullRequest>()
  readonly merges: { id: string; method: MergeMethod }[] = []
  readonly outsiders = new Set<string>()
  readonly pullTitles: string[] = []
  readonly labels = new Set<string>()
  mergeError: string | undefined
  private nextId = 1

  constructor(
    private readonly login: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async user() {
    return this.login
  }

  async prepare(stages: string[]) {
    for (const label of boardLabels(stages)) this.labels.add(label.name)
  }

  async boardUrl() {
    return 'https://example.test/board'
  }

  async canWrite(user: string) {
    return Boolean(user) && !this.outsiders.has(user)
  }

  async createTask(title: string, body: string, labels: TaskLabels = {}) {
    return this.createTaskAs(this.login, title, body, labels)
  }

  async createTaskAs(author: string, title: string, body: string, labels: TaskLabels = {}) {
    const id = String(this.nextId++)
    this.issues.set(id, {
      title,
      body,
      author,
      labels: taskLabels(labels),
      assignees: [],
      closed: false,
      createdAt: this.now().toISOString(),
      blockers: new Set(),
    })
    return this.toTask(id)
  }

  async listTasks() {
    return [...this.issues.keys()].map((id) => this.toTask(id)).filter((task) => !task.closed && onBoard(task))
  }

  async getTask(id: string) {
    return this.issues.has(id) ? this.toTask(id) : undefined
  }

  async setState(id: string, state: TaskState) {
    this.replaceLabel(id, STATE_LABEL, STATE_LABEL + state)
  }

  async setForm(id: string, form: TaskForm | undefined) {
    this.replaceLabel(id, FORM_LABEL, form ? FORM_LABEL + form : undefined)
  }

  async setStage(id: string, stage: string | undefined) {
    this.replaceLabel(id, STAGE_LABEL, stage ? STAGE_LABEL + stage : undefined)
  }

  async setPart(id: string, part: string | undefined) {
    this.replaceLabel(id, PART_LABEL, part ? PART_LABEL + part : undefined)
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
    return this.addCommentAs(this.login, id, body)
  }

  async addCommentAs(author: string, id: string, body: string) {
    this.issue(id)
    const time = this.now().toISOString()
    const comment = { id: `c${this.comments.size + 1}`, author, body, createdAt: time, updatedAt: time }
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

  async setPriority(id: string, priority: number) {
    this.replaceLabel(id, PRIORITY_LABEL, PRIORITY_LABEL + priority)
  }

  async openPullRequest(id: string, title: string) {
    const existing = this.pulls.get(id)
    if (existing?.state === 'open') return { ...existing }
    const pull: PullRequest = {
      number: String(1000 + this.pulls.size),
      url: `https://example.test/pull/${id}`,
      headSha: id.padStart(40, '0'),
      state: 'open',
      checks: 'none',
      mergeable: 'yes',
      feedback: [],
      reviews: [],
      comments: [],
    }
    this.pulls.set(id, pull)
    this.pullTitles.push(title)
    return { ...pull }
  }

  async pullRequest(id: string) {
    const pull = this.pulls.get(id)
    return pull ? { ...pull, feedback: [...pull.feedback], reviews: [...pull.reviews], comments: [...pull.comments] } : undefined
  }

  async mergePullRequest(id: string, method: MergeMethod, sha: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const pull = this.pulls.get(id)
    if (!pull || pull.state !== 'open') return { ok: false, error: 'no open pull request' }
    if (pull.headSha !== sha) return { ok: false, error: 'the head of the branch changed' }
    if (this.mergeError) return { ok: false, error: this.mergeError }
    pull.state = 'merged'
    this.merges.push({ id, method })
    return { ok: true }
  }

  async commentPullRequest(id: string, body: string) {
    const pull = this.pulls.get(id)
    if (!pull) throw new Error(`task ${id} has no pull request`)
    pull.comments.push({ author: this.login, body, createdAt: this.now().toISOString() })
  }

  async closePullRequest(id: string) {
    const pull = this.pulls.get(id)
    if (pull) pull.state = 'closed'
  }

  updatePullRequest(id: string, patch: Partial<PullRequest>) {
    const pull = this.pulls.get(id)
    if (!pull) throw new Error(`no pull request for task ${id}`)
    Object.assign(pull, patch)
  }

  assign(id: string, ...logins: string[]) {
    this.issue(id).assignees = logins
  }

  labelsOf(id: string) {
    return [...this.issue(id).labels]
  }

  addLabel(id: string, label: string) {
    this.issue(id).labels.push(label)
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
      author: issue.author,
      url: `https://example.test/issues/${id}`,
      assignees: [...issue.assignees],
      openBlockers: [...issue.blockers].filter((blocker) => !this.issue(blocker).closed).length,
      closed: issue.closed,
      createdAt: issue.createdAt,
      ...labelsToTask(issue.labels),
    }
  }
}
