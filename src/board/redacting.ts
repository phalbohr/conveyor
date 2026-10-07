import { redactSecrets } from '../engine/redact.js'
import type { Board, MergeMethod, TaskState } from './board.js'

export class RedactingBoard implements Board {
  constructor(
    private readonly board: Board,
    private readonly secrets: string[],
  ) {}

  private clean(text: string) {
    return redactSecrets(text, this.secrets)
  }

  user() {
    return this.board.user()
  }

  canWrite(user: string) {
    return this.board.canWrite(user)
  }

  createTask(title: string, body: string, state?: TaskState) {
    return this.board.createTask(this.clean(title), this.clean(body), state)
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

  setOwner(id: string, owner: string | undefined) {
    return this.board.setOwner(id, owner)
  }

  updateBody(id: string, body: string) {
    return this.board.updateBody(id, this.clean(body))
  }

  closeTask(id: string) {
    return this.board.closeTask(id)
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

  openPullRequest(id: string, title: string, body: string) {
    return this.board.openPullRequest(id, this.clean(title), this.clean(body))
  }

  pullRequest(id: string) {
    return this.board.pullRequest(id)
  }

  mergePullRequest(id: string, method: MergeMethod, sha: string) {
    return this.board.mergePullRequest(id, method, sha)
  }

  closePullRequest(id: string) {
    return this.board.closePullRequest(id)
  }
}
