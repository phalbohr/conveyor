export const TASK_STATES = ['backlog', 'needs-input', 'queued', 'in-progress', 'review', 'rework', 'done'] as const
export const TASK_FORMS = ['idea', 'story', 'plan'] as const

export type TaskState = (typeof TASK_STATES)[number]
export type TaskForm = (typeof TASK_FORMS)[number]

export type Task = {
  id: string
  title: string
  body: string
  author: string
  url: string
  labels: string[]
  state?: TaskState
  form?: TaskForm
  stage?: string
  owner?: string
  assignees: string[]
  priority?: number
  fixing?: boolean
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
  headSha: string
  state: 'open' | 'merged' | 'closed'
  checks: 'pending' | 'success' | 'failure' | 'none'
  mergeable: 'yes' | 'no' | 'unknown'
  draft?: boolean
  headAt?: string
  blocked?: string
  feedback: { author: string; body: string }[]
  reviews: { author: string; state: 'approved' | 'changes_requested' | 'commented' | 'dismissed'; body: string; submittedAt: string }[]
  comments: { author: string; body: string; createdAt: string }[]
}

export type LinkedPull = { number: string; url: string; branch: string; draft: boolean; author: string }

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export const taskSlug = (id: string) => id.replace('#', '-')

export const taskFile = (id: string) => taskSlug(id).replaceAll('/', '+')

export const taskOfFile = (name: string) => (/^\d+$/.test(name) ? name : name.replaceAll('+', '/').replace(/-(\d+)$/, '#$1'))

export const taskRef = (id: string) => (id.includes('#') ? id : `#${id}`)

export interface Board {
  user(): Promise<string>
  boardUrl(): Promise<string>
  branchUrl(branch: string): Promise<string>
  reference(id: string): string
  baseBranch(repo?: string): Promise<string>
  inspect(): Promise<BoardInspection>
  syncMirror(tasks: Task[]): Promise<number>
  linkedProjects(): Promise<LinkedProject[]>
  createProject(title: string): Promise<LinkedProject>
  prepare(stages: string[]): Promise<void>
  canWrite(user: string): Promise<boolean>
  createTask(title: string, body: string, labels?: TaskLabels): Promise<Task>
  listTasks(): Promise<Task[]>
  getTask(id: string): Promise<Task | undefined>
  setState(id: string, state: TaskState): Promise<void>
  setForm(id: string, form: TaskForm | undefined): Promise<void>
  setStage(id: string, stage: string | undefined): Promise<void>
  setPart(id: string, part: string | undefined): Promise<void>
  setFixing(id: string, fixing: boolean): Promise<void>
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
  openPullRequest(id: string, title: string, body: string, repo?: string, draft?: boolean): Promise<PullRequest>
  readyPullRequest(id: string, title: string, body: string, repo?: string): Promise<void>
  pullRequest(id: string, repo?: string): Promise<PullRequest | undefined>
  mergePullRequest(id: string, method: MergeMethod, sha: string, repo?: string): Promise<{ ok: true } | { ok: false; error: string }>
  closePullRequest(id: string, repo?: string): Promise<void>
  mergeCommit(id: string, repo?: string): Promise<string | undefined>
  commitChecks(sha: string, repo?: string): Promise<PullRequest['checks']>
  failedChecks(sha: string, repo?: string): Promise<string[]>
  baseHead(repo?: string): Promise<string>
  linkedPulls(id: string): Promise<LinkedPull[]>
  commentPullRequest(id: string, body: string, repo?: string): Promise<void>
}

export type TaskLabels = { state?: TaskState; form?: TaskForm }
export type BoardInspection = { labels: string[]; field?: { options: string[] } | 'missing'; issues: { id: string; title: string; labels: string[] }[] }
export type LinkedProject = { number: number; title: string; url: string }
export const CONVEYOR_PREFIXES = ['conveyor::', 'form::', 'stage::']

export const STATE_COLORS: Record<TaskState, string> = {
  backlog: 'ededed',
  'needs-input': 'd93f0b',
  queued: 'cccccc',
  'in-progress': 'fbca04',
  review: '5319e7',
  rework: 'b60205',
  done: '0052cc',
}
export const FORM_COLOR = '0e8a16'
export const STAGE_COLOR = 'bfd4f2'

export const STATE_LABEL = 'conveyor::'
export const FORM_LABEL = 'form::'
export const STAGE_LABEL = 'stage::'
export const PART_LABEL = 'part::'
export const FIX_LABEL = 'fix::ci'
export const OWNER_LABEL = 'claimed-by::'
export const PRIORITY_LABEL = 'priority::'

export function boardLabels(stages: string[]): { name: string; color: string }[] {
  return [
    ...TASK_STATES.map((state) => ({ name: STATE_LABEL + state, color: STATE_COLORS[state] })),
    ...TASK_FORMS.map((form) => ({ name: FORM_LABEL + form, color: FORM_COLOR })),
    ...stages.map((stage) => ({ name: STAGE_LABEL + stage, color: STAGE_COLOR })),
  ]
}

export function taskLabels(labels: TaskLabels): string[] {
  return [...(labels.state ? [STATE_LABEL + labels.state] : []), ...(labels.form ? [FORM_LABEL + labels.form] : [])]
}

export function onBoard(task: Task) {
  return task.form !== undefined || task.state !== undefined
}

export function labelsToTask(labels: string[]): Pick<Task, 'state' | 'form' | 'stage' | 'owner' | 'priority' | 'fixing'> {
  const value = (prefix: string) => labels.find((label) => label.startsWith(prefix))?.slice(prefix.length)
  const state = value(STATE_LABEL)
  const form = value(FORM_LABEL)
  const stage = value(STAGE_LABEL)
  const priority = Number(value(PRIORITY_LABEL))
  return {
    ...(state && (TASK_STATES as readonly string[]).includes(state) ? { state: state as TaskState } : {}),
    ...(form && (TASK_FORMS as readonly string[]).includes(form) ? { form: form as TaskForm } : {}),
    ...(stage ? { stage } : {}),
    ...(value(OWNER_LABEL) ? { owner: value(OWNER_LABEL) } : {}),
    ...(Number.isInteger(priority) && priority > 0 ? { priority } : {}),
    ...(labels.includes(FIX_LABEL) ? { fixing: true } : {}),
  }
}

export function ignoredCheck(name: string, patterns: string[]) {
  return patterns.some((pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(name))
}
