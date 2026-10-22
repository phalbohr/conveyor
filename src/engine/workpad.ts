import { z } from 'zod'
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
  reviewMode?: 'fix' | 'rework'
  headSha?: string
  parts?: string[]
  part?: number
  form?: 'idea' | 'story' | 'plan'
  checksWait?: { sha: string; since: string }
  branch?: string
  verify?: { sha: string; since: string; head?: string; before?: string }
  broken?: string
  followUp?: boolean
  repairs?: number
  source?: string
  split?: boolean
  pull?: { number: string; url: string }
  parked?: string
  repos?: Record<string, RepoPull>
  mergeOrder?: string[]
  runs?: Record<string, number>
  stageBase?: string
  partBase?: string
  lastResult?: string
}

export type RepoPull = { number: string; url: string; headSha?: string; merged?: boolean; verify?: { sha: string; since: string; head?: string; before?: string }; checksWait?: { sha: string; since: string } }

export type Workpad = { id: string; state: WorkpadState; text: string }

const stateSchema = z.object({
  stage: z.string().optional(),
  attempt: z.int().nonnegative(),
  retryAt: z.iso.datetime().optional(),
  waiting: z
    .object({
      kind: z.enum(['questions', 'approval', 'error', 'review']),
      since: z.iso.datetime(),
      stage: z.string().optional(),
      commentId: z.string().optional(),
    })
    .optional(),
  heartbeat: z.iso.datetime().optional(),
  private: z.boolean().optional(),
  lastError: z.string().optional(),
  landing: z.enum(['success', 'failure']).optional(),
  mergeError: z.string().optional(),
  landAttempts: z.int().nonnegative().optional(),
  review: z.string().optional(),
  reviewMode: z.enum(['fix', 'rework']).optional(),
  headSha: z.string().optional(),
  parts: z.array(z.string()).optional(),
  part: z.int().nonnegative().optional(),
  form: z.enum(['idea', 'story', 'plan']).optional(),
  checksWait: z.object({ sha: z.string(), since: z.iso.datetime() }).optional(),
  branch: z.string().optional(),
  verify: z.object({ sha: z.string(), since: z.iso.datetime(), head: z.string().optional(), before: z.string().optional() }).optional(),
  broken: z.string().optional(),
  followUp: z.boolean().optional(),
  repairs: z.int().nonnegative().optional(),
  source: z.string().optional(),
  split: z.boolean().optional(),
  pull: z.object({ number: z.string(), url: z.string() }).optional(),
  parked: z.string().optional(),
  repos: z
    .record(
      z.string(),
      z.object({
        number: z.string(),
        url: z.string(),
        headSha: z.string().optional(),
        merged: z.boolean().optional(),
        verify: z.object({ sha: z.string(), since: z.iso.datetime(), head: z.string().optional(), before: z.string().optional() }).optional(),
        checksWait: z.object({ sha: z.string(), since: z.iso.datetime() }).optional(),
      }),
    )
    .optional(),
  mergeOrder: z.array(z.string()).optional(),
  runs: z.record(z.string(), z.int().nonnegative()).optional(),
  stageBase: z.string().optional(),
  partBase: z.string().optional(),
  lastResult: z.string().optional(),
})

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
    const state = stateSchema.safeParse(parseJson(match[1]))
    if (!state.success) continue
    const text = comment.body.slice(match[0].length).replace(/^### Conveyor workpad\n\n(?:Stage: .*\n\n)?(?:Branch: .*\n\n)?(?:Last error: .*\n\n)?/, '')
    return { id: comment.id, state: state.data as WorkpadState, text }
  }
  return undefined
}

export function renderWorkpad(state: WorkpadState, text: string) {
  state = JSON.parse(JSON.stringify(state, (_, value: unknown) => (typeof value === 'string' ? plain(value) : value))) as WorkpadState
  const stage = state.stage ? `Stage: \`${state.stage}\`${state.attempt ? ` · failed attempts: ${state.attempt}` : ''}\n\n` : ''
  const error = state.lastError ? `Last error: ${state.lastError.replaceAll('\n', ' ')}\n\n` : ''
  const links = [
    state.branch ? `[${state.branch.split('/tree/').at(-1)}](${state.branch})` : '',
    state.pull ? `pull request [#${state.pull.number}](${state.pull.url})` : '',
    state.repos && Object.keys(state.repos).length ? `merge requests ${Object.entries(state.repos).map(([repo, pull]) => `[${repo} !${pull.number}](${pull.url})${pull.merged ? ' (merged)' : ''}`).join(', ')}` : '',
  ].filter(Boolean)
  const linked = links.length ? `Branch: ${links.join(' · ')}\n\n` : ''
  return `${AGENT_MARKER}:workpad ${JSON.stringify(state).replaceAll('>', '\\u003e')} -->\n### Conveyor workpad\n\n${stage}${linked}${error}${text}`
}

export function repliesSince(comments: Comment[], commentId: string | undefined): Comment[] {
  const index = comments.findIndex((comment) => comment.id === commentId)
  if (index < 0) return []
  return comments.slice(index + 1).filter((comment) => !isAgentComment(comment))
}

export function plain(text: string) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
