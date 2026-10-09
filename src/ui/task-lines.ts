import type { Comment, PullRequest, Task } from '../board/board.js'
import type { Line } from './status-lines.js'

export type Target = 'issue' | 'pull'

export type TaskDetail = {
  task: Task
  workpad?: { stage?: string; text: string }
  comments: Comment[]
  pull?: PullRequest
}

export type TaskControl = {
  detail(id: string): Promise<TaskDetail>
  comment(id: string, target: Target, body: string): Promise<void>
  toggleIdea(id: string): Promise<string>
  open(url: string): Promise<void>
  openBoard(): Promise<void>
}

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
const text = (body: string, indent = '  '): Line[] => (body.trim() ? body.trim().split('\n').map((line) => ({ text: `${indent}${line}` })) : [{ text: `${indent}(empty)`, tone: 'muted' }])

export function taskLines(detail: TaskDetail, target: Target): Line[] {
  const { task, pull } = detail
  const labels = [task.state ? `conveyor::${task.state}` : '', task.form ? `form::${task.form}` : '', task.stage ? `stage::${task.stage}` : '', task.owner ? `claimed by @${task.owner}` : '']
    .filter(Boolean)
    .join(' · ')
  if (target === 'pull' && pull) {
    return [
      { text: `#${task.id} ${task.title} · pull request ${pull.number}`, tone: 'title' },
      { text: `${pull.state} · checks ${pull.checks} · mergeable ${pull.mergeable} · ${pull.url}`, tone: 'muted' },
      { text: '' },
      { text: `Reviews (${pull.reviews.length})`, tone: 'title' },
      ...(pull.reviews.length ? pull.reviews.flatMap((review) => [{ text: `@${review.author} · ${review.state} · ${time(review.submittedAt)}`, tone: 'muted' as const }, ...(review.body.trim() ? text(review.body) : [])]) : [{ text: '  none', tone: 'muted' as const }]),
      { text: '' },
      { text: `Comments (${pull.comments.length})`, tone: 'title' },
      ...(pull.comments.length ? pull.comments.flatMap((comment) => [{ text: `@${comment.author} · ${time(comment.createdAt)}`, tone: 'muted' as const }, ...text(comment.body)]) : [{ text: '  none', tone: 'muted' as const }]),
      ...(pull.feedback.length ? [{ text: '' }, { text: `Code comments (${pull.feedback.length})`, tone: 'title' as const }, ...pull.feedback.flatMap((comment) => [{ text: `@${comment.author}`, tone: 'muted' as const }, ...text(comment.body)])] : []),
    ]
  }
  return [
    { text: `#${task.id} ${task.title}`, tone: 'title' },
    { text: `${labels || 'no conveyor labels'} · ${task.url}`, tone: 'muted' },
    ...(pull ? [{ text: `pull request ${pull.number} · ${pull.state} · checks ${pull.checks} · [p] open it here`, tone: 'muted' as const }] : []),
    { text: '' },
    { text: 'Description', tone: 'title' },
    ...text(task.body),
    ...(detail.workpad ? [{ text: '' }, { text: `Workpad${detail.workpad.stage ? ` · stage ${detail.workpad.stage}` : ''}`, tone: 'title' as const }, ...text(detail.workpad.text)] : []),
    { text: '' },
    { text: `Comments (${detail.comments.length})`, tone: 'title' },
    ...(detail.comments.length ? detail.comments.flatMap((comment) => [{ text: `@${comment.author} · ${time(comment.createdAt)}`, tone: 'muted' as const }, ...text(comment.body)]) : [{ text: '  none', tone: 'muted' as const }]),
  ]
}
