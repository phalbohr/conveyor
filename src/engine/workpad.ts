import type { Comment } from '../board/board.js'

export type Waiting = {
  kind: 'questions' | 'approval' | 'error' | 'review'
  since: string
  stage?: string
  commentId?: string
}

export type WorkpadState = {
  stage?: string
  attempt: number
  retryAt?: string
  waiting?: Waiting
  heartbeat?: string
  private?: boolean
  lastError?: string
  landing?: 'success' | 'failure'
  mergeError?: string
  landAttempts?: number
  review?: string
}

export type Workpad = { id: string; state: WorkpadState; text: string }

const AGENT_MARKER = '<!-- conveyor'
const WORKPAD = /^<!-- conveyor:workpad (\{.*?\}) -->\n/

export function isAgentComment(comment: Pick<Comment, 'body'>) {
  return comment.body.startsWith(AGENT_MARKER)
}

export function agentComment(kind: string, body: string) {
  return `${AGENT_MARKER}:${kind} -->\n${body}`
}

export function commentText(comment: Pick<Comment, 'body'>) {
  return isAgentComment(comment) ? comment.body.slice(comment.body.indexOf('\n') + 1) : comment.body
}

export function findWorkpad(comments: Comment[]): Workpad | undefined {
  for (const comment of comments) {
    const match = comment.body.match(WORKPAD)
    if (!match?.[1]) continue
    const text = comment.body.slice(match[0].length).replace(/^### Conveyor workpad\n\n(?:Stage: .*\n\n)?(?:Last error: .*\n\n)?/, '')
    return { id: comment.id, state: JSON.parse(match[1]) as WorkpadState, text }
  }
  return undefined
}

export function renderWorkpad(state: WorkpadState, text: string) {
  const stage = state.stage ? `Stage: \`${state.stage}\`${state.attempt ? ` · failed attempts: ${state.attempt}` : ''}\n\n` : ''
  const error = state.lastError ? `Last error: ${state.lastError.replaceAll('\n', ' ')}\n\n` : ''
  return `${AGENT_MARKER}:workpad ${JSON.stringify(state).replaceAll('>', '\\u003e')} -->\n### Conveyor workpad\n\n${stage}${error}${text}`
}

export function repliesSince(comments: Comment[], commentId: string | undefined): Comment[] {
  const index = comments.findIndex((comment) => comment.id === commentId)
  if (index < 0) return []
  return comments.slice(index + 1).filter((comment) => !isAgentComment(comment))
}
