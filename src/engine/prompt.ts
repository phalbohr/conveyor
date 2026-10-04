import type { Task } from '../board/board.js'

export type GateMode = 'interactive' | 'autonomous' | 'smart'

export type PromptInput = {
  task: Task
  stage: string
  instructions: string
  gate?: { mode: GateMode; criteria: string }
  artifacts: Record<string, string>
  workpad: string
  conversation?: { request: string; replies: string[]; approval: boolean }
  attempt: number
  language: string
  review?: string
  reviewMode?: 'fix' | 'rework'
  merge?: string
  mergeCriteria?: string
}

const MODES: Record<GateMode, string> = {
  interactive:
    'Interactive mode. Ask questions with outcome `needs_input` when you need information. When the result is ready, return outcome `approval` with the artifact, so a human can review it.',
  autonomous: 'Autonomous mode. Do not ask questions. Make the decisions yourself and return outcome `done` with the artifact.',
  smart:
    'Smart mode. Ask questions with outcome `needs_input` or request approval with outcome `approval` only when the criteria below require it. Otherwise return outcome `done`.',
}

export function buildPrompt(input: PromptInput): string {
  const sections = [
    `You run the "${input.stage}" stage of the development conveyor for task #${input.task.id}: ${input.task.title}`,
    `## Stage instructions\n\n${input.instructions.trim() || 'No extra instructions.'}`,
  ]
  if (input.gate) {
    const criteria = input.gate.mode === 'smart' && input.gate.criteria.trim() ? `\n\n${input.gate.criteria.trim()}` : ''
    sections.push(`## Decision mode\n\n${MODES[input.gate.mode]}${criteria}`)
  }
  sections.push(`## Task\n\n${input.task.body.trim() || '(empty)'}`)
  for (const [kind, content] of Object.entries(input.artifacts)) sections.push(`## Artifact: ${kind}\n\n${content.trim()}`)
  if (input.workpad.trim()) sections.push(`## Workpad from earlier stages\n\n${input.workpad.trim()}`)
  if (input.conversation) {
    const replies = input.conversation.replies.map((reply) => `> ${reply.trim().replaceAll('\n', '\n> ')}`).join('\n\n')
    const note = input.conversation.approval
      ? 'You asked for approval. If the human approves, return outcome `done` without changes. If the human asks for changes, revise the result and ask for approval again.'
      : 'You asked these questions. Continue the stage with the answers.'
    sections.push(`## Conversation\n\n${note}\n\nYour request:\n\n${input.conversation.request.trim()}\n\nReplies:\n\n${replies}`)
  }
  if (input.review) {
    const feedback = `> ${input.review.trim().replaceAll('\n', '\n> ')}`
    const intro =
      input.reviewMode === 'fix'
        ? 'A reviewer asked for fixes. Work on the existing branch and change only what the feedback asks for. Keep the rest of the work.'
        : 'A reviewer asked for a different approach. The task restarts from a fresh branch.'
    sections.push(`## Review feedback\n\n${intro} Address every point:\n\n${feedback}`)
  }
  if (input.merge) sections.push(`## Merge\n\n${input.merge}`)
  if (input.mergeCriteria !== undefined) {
    sections.push(
      `## Merge decision\n\nDecide if this change needs human review. Return outcome \`approval\` with the reason in the summary if the criteria below require human review. Otherwise return outcome \`done\`, and the conveyor merges the change.\n\n${input.mergeCriteria.trim()}`,
    )
  }
  if (input.attempt > 0) sections.push(`## Retry\n\nThis stage failed ${input.attempt} time(s) before. Check the workpad and change your approach.`)
  sections.push(
    `## Language\n\nWrite the artifact, the summary, the questions, and the workpad in ${input.language}. The whole team reads them.`,
  )
  sections.push(
    '## Result\n\nReturn the structured result: `outcome` (`done`, `needs_input`, `approval`, or `failed`), a short `summary`, an `artifact` if this stage produces one, `questions` with `needs_input`, and an updated `workpad` in markdown (plan, checklist, validation, notes). Do not write to the issue tracker yourself.',
  )
  return `${sections.join('\n\n')}\n`
}

export function buildTriagePrompt(input: { instructions: string; tasks: Task[]; fresh: string[]; language: string }): string {
  const tasks = input.tasks
    .map((task) => {
      const marks = [
        `state: ${task.state ?? 'none'}`,
        `priority: ${task.priority ?? 'none'}`,
        input.fresh.includes(task.id) ? 'NEW' : '',
      ].filter(Boolean)
      return `### #${task.id} ${task.title} (${marks.join(', ')})\n\n${task.body.trim().slice(0, 1500) || '(empty)'}`
    })
    .join('\n\n')
  return `${[
    'You run the triage of the development conveyor. Do not change files and do not write to the issue tracker.',
    `## Instructions\n\n${input.instructions.trim() || 'Order the tasks and find dependencies between them.'}`,
    `## Open tasks\n\n${tasks}`,
    `## Result\n\nSet a priority (1 is the most urgent, 4 the least) for every task marked NEW. For any task, list the tasks that must be done before it in \`blocked_by\`. Return outcome \`done\`, a short \`summary\` in ${input.language}, and an \`artifact\` with kind \`triage\` whose content is JSON:\n\n\`\`\`json\n{"tasks": [{"id": "12", "priority": 2, "blocked_by": ["10"]}]}\n\`\`\``,
  ].join('\n\n')}\n`
}
