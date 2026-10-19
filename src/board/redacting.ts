import { redactSecrets } from '../engine/redact.js'
import type { Board, MergeMethod, Task, TaskForm, TaskLabels, TaskState } from './board.js'

export class RedactingBoard implements Board {
  constructor(
    private readonly board: Board,
    private readonly secrets: () => string[],
  ) {}

  private clean(text: string) {
    return redactSecrets(text, this.secrets())
  }

  user() {
    return this.board.user()
  }

  prepare(stages: string[]) {
    return this.board.prepare(stages)
  }

  inspect() {
    return this.board.inspect()
  }

  syncMirror(tasks: Task[]) {
    return this.board.syncMirror(tasks)
  }

  mergeCommit(id: string, repo?: string) {
    return this.board.mergeCommit(id, repo)
  }

  commitChecks(sha: string, repo?: string) {
    return this.board.commitChecks(sha, repo)
  }

  failedChecks(sha: string, repo?: string) {
    return this.board.failedChecks(sha, repo)
  }

  passedChecks(sha: string, repo?: string) {
    return this.board.passedChecks(sha, repo)
  }

  baseHead(repo?: string) {
    return this.board.baseHead(repo)
  }

  linkedPulls(id: string) {
    return this.board.linkedPulls(id)
  }

  baseBranch(repo?: string) {
    return this.board.baseBranch(repo)
  }

  linkedProjects() {
    return this.board.linkedProjects()
  }

  createProject(title: string) {
    return this.board.createProject(title)
  }

  boardUrl() {
    return this.board.boardUrl()
  }

  branchUrl(branch: string) {
    return this.board.branchUrl(branch)
  }

  reference(id: string) {
    return this.board.reference(id)
  }

  canWrite(user: string) {
    return this.board.canWrite(user)
  }

  createTask(title: string, body: string, labels?: TaskLabels) {
    return this.board.createTask(this.clean(title), this.clean(body), labels)
  }

  listTasks() {
    return this.board.listTasks()
  }

  getTask(id: string) {
    return this.board.getTask(id)
  }

  setState(id: string, state: TaskState) {
    return this.board.setState(id, state)
  }

  setForm(id: string, form: TaskForm | undefined) {
    return this.board.setForm(id, form)
  }

  setStage(id: string, stage: string | undefined) {
    return this.board.setStage(id, stage)
  }

  setPart(id: string, part: string | undefined) {
    return this.board.setPart(id, part)
  }

  setFixing(id: string, fixing: boolean) {
    return this.board.setFixing(id, fixing)
  }

  setOwner(id: string, owner: string | undefined) {
    return this.board.setOwner(id, owner)
  }

  updateBody(id: string, body: string) {
    return this.board.updateBody(id, this.clean(body))
  }

  closeTask(id: string) {
    return this.board.closeTask(id)
  }

  deleteTask(id: string) {
    return this.board.deleteTask(id)
  }

  listComments(id: string) {
    return this.board.listComments(id)
  }

  addComment(id: string, body: string) {
    return this.board.addComment(id, this.clean(body))
  }

  updateComment(commentId: string, body: string) {
    return this.board.updateComment(commentId, this.clean(body))
  }

  addBlocker(id: string, blockerId: string) {
    return this.board.addBlocker(id, blockerId)
  }

  claim(id: string) {
    return this.board.claim(id)
  }

  release(id: string) {
    return this.board.release(id)
  }

  setPriority(id: string, priority: number) {
    return this.board.setPriority(id, priority)
  }

  openPullRequest(id: string, title: string, body: string, repo?: string, draft?: boolean) {
    return this.board.openPullRequest(id, this.clean(title), this.clean(body), repo, draft)
  }

  readyPullRequest(id: string, title: string, body: string, repo?: string) {
    return this.board.readyPullRequest(id, this.clean(title), this.clean(body), repo)
  }

  pullRequest(id: string, repo?: string) {
    return this.board.pullRequest(id, repo)
  }

  mergePullRequest(id: string, method: MergeMethod, sha: string, repo?: string) {
    return this.board.mergePullRequest(id, method, sha, repo)
  }

  commentPullRequest(id: string, body: string, repo?: string) {
    return this.board.commentPullRequest(id, this.clean(body), repo)
  }

  closePullRequest(id: string, repo?: string) {
    return this.board.closePullRequest(id, repo)
  }
}
