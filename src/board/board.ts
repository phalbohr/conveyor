export const TASK_STATES = ['idea', 'story', 'plan', 'in-progress', 'needs-input', 'queued', 'review', 'rework', 'done'] as const

export type TaskState = (typeof TASK_STATES)[number]

export type Task = {
  id: string
  title: string
  body: string
  author: string
  state?: TaskState
  owner?: string
  assignees: string[]
  priority?: number
  openBlockers: number
  closed: boolean
  createdAt: string
}

export type Comment = {
  id: string
  author: string
  body: string
  createdAt: string
  updatedAt: string
}

export type PullRequest = {
  number: string
  url: string
  state: 'open' | 'merged' | 'closed'
  checks: 'pending' | 'success' | 'failure' | 'none'
  mergeable: 'yes' | 'no' | 'unknown'
  feedback: { author: string; body: string }[]
  reviews: { author: string; state: 'approved' | 'changes_requested' | 'commented' | 'dismissed'; body: string; submittedAt: string }[]
  comments: { author: string; body: string; createdAt: string }[]
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface Board {
  user(): Promise<string>
  canWrite(user: string): Promise<boolean>
  createTask(title: string, body: string, state?: TaskState): Promise<Task>
  listTasks(): Promise<Task[]>
  getTask(id: string): Promise<Task | undefined>
  setState(id: string, state: TaskState): Promise<void>
  setOwner(id: string, owner: string | undefined): Promise<void>
  updateBody(id: string, body: string): Promise<void>
  closeTask(id: string): Promise<void>
  listComments(id: string): Promise<Comment[]>
  addComment(id: string, body: string): Promise<Comment>
  updateComment(commentId: string, body: string): Promise<void>
  addBlocker(id: string, blockerId: string): Promise<void>
  claim(id: string): Promise<boolean>
  release(id: string): Promise<void>
  setPriority(id: string, priority: number): Promise<void>
  openPullRequest(id: string, title: string, body: string): Promise<PullRequest>
  pullRequest(id: string): Promise<PullRequest | undefined>
  mergePullRequest(id: string, method: MergeMethod): Promise<{ ok: true } | { ok: false; error: string }>
  closePullRequest(id: string): Promise<void>
}

export const STATE_LABEL = 'conveyor::'
export const OWNER_LABEL = 'claimed-by::'
export const PRIORITY_LABEL = 'priority::'

export function labelsToTask(labels: string[]): Pick<Task, 'state' | 'owner' | 'priority'> {
  const value = (prefix: string) => labels.find((label) => label.startsWith(prefix))?.slice(prefix.length)
  const state = value(STATE_LABEL)
  const priority = Number(value(PRIORITY_LABEL))
  return {
    ...(state && (TASK_STATES as readonly string[]).includes(state) ? { state: state as TaskState } : {}),
    ...(value(OWNER_LABEL) ? { owner: value(OWNER_LABEL) } : {}),
    ...(Number.isInteger(priority) && priority > 0 ? { priority } : {}),
  }
}
