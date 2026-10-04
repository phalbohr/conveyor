import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import type { Interact } from '../src/cli.js'
import { renderWorkpad } from '../src/engine/workpad.js'
import { runCli } from './helpers.js'

type Session = { command: string; args: string[]; env: NodeJS.ProcessEnv }

function agent(result?: string): { interact: Interact; sessions: Session[] } {
  const sessions: Session[] = []
  return {
    sessions,
    interact: async (command, args, options) => {
      sessions.push({ command, args, env: options.env })
      if (result !== undefined && options.env.CONVEYOR_RESULT) writeFileSync(options.env.CONVEYOR_RESULT, result)
      return 0
    },
  }
}

async function project(config = '') {
  const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
  if (config) writeFileSync(`${init.context.cwd}/.conveyor/config.yaml`, `board: {provider: github, project: acme/app}\n${config}`)
  return { cwd: init.context.cwd, home: init.context.home }
}

describe('conveyor new', () => {
  it('creates a task from the result of the live session', async () => {
    const board = new FakeBoard('me')
    const { interact, sessions } = agent('---\ntitle: Export to CSV\nstate: story\n---\nAs a user, I want to export reports.\n')
    const result = await runCli(['new'], { ...(await project()), board, interact })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Created task 1')
    expect(await board.getTask('1')).toMatchObject({ title: 'Export to CSV', body: 'As a user, I want to export reports.', state: 'story' })
    expect(sessions[0]?.command).toBe('claude')
    expect(sessions[0]?.args.join(' ')).toContain('--model opus')
    expect(sessions[0]?.args.at(-1)).toContain(sessions[0]?.env.CONVEYOR_RESULT)
  })

  it('uses the harness and model of the story stage and strips board credentials', async () => {
    const board = new FakeBoard('me')
    const { interact, sessions } = agent('---\ntitle: T\nstate: idea\n---\nAn idea.\n')
    process.env.GH_TOKEN = 'secret'
    try {
      await runCli(['new'], { ...(await project('stages:\n  story: {harness: codex, model: gpt-6-luna, effort: high}\n')), board, interact })
    } finally {
      delete process.env.GH_TOKEN
    }
    expect(sessions[0]?.command).toBe('codex')
    expect(sessions[0]?.args.join(' ')).toContain('-m gpt-6-luna')
    expect(sessions[0]?.env.GH_TOKEN).toBeUndefined()
  })

  it('talks in the chat language, writes in the documentation language, and uses the story format', async () => {
    const board = new FakeBoard('me')
    const { interact, sessions } = agent('---\ntitle: T\nstate: idea\n---\nAn idea.\n')
    const { cwd, home } = await project('language: {docs: English}\n')
    writeFileSync(`${cwd}/.conveyor/local.yaml`, 'language: {chat: Russian}\n')
    await runCli(['new'], { cwd, home, board, interact })
    const prompt = sessions[0]?.args.at(-1) ?? ''
    expect(prompt).toContain('Talk to the human in Russian')
    expect(prompt).toContain('in English')
    expect(prompt).toContain('**Acceptance criteria:**')
  })

  it('creates nothing when the session ends without a result', async () => {
    const board = new FakeBoard('me')
    const result = await runCli(['new'], { ...(await project()), board, interact: agent().interact })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no result')
    expect(await board.listTasks()).toEqual([])
  })

  it('rejects a result with an invalid state', async () => {
    const board = new FakeBoard('me')
    const { interact } = agent('---\ntitle: T\nstate: done\n---\nBody\n')
    const result = await runCli(['new'], { ...(await project()), board, interact })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('state')
  })

  it('prints the created task as JSON', async () => {
    const board = new FakeBoard('me')
    const { interact } = agent('---\ntitle: T\nstate: idea\n---\nBody\n')
    const result = await runCli(['new', '--json'], { ...(await project()), board, interact })
    expect(JSON.parse(result.stdout)).toEqual({ id: '1', title: 'T', state: 'idea' })
  })
})

describe('conveyor attach', () => {
  async function waitingTask(board: FakeBoard) {
    const task = await board.createTask('Store users', 'the plan', 'needs-input')
    const question = await board.addComment(task.id, '<!-- conveyor:questions -->\n**Questions from the `implement` stage:**\n\n1. Which database?')
    await board.addComment(
      task.id,
      renderWorkpad({ attempt: 0, waiting: { kind: 'questions', stage: 'implement', commentId: question.id, since: new Date().toISOString() } }, ''),
    )
    return task
  }

  it('posts the answer from the live session as a human comment', async () => {
    const board = new FakeBoard('me')
    const task = await waitingTask(board)
    const { interact, sessions } = agent('Use Postgres with a users table.\n')

    const result = await runCli(['attach', task.id], { ...(await project('stages:\n  implement: {model: sonnet}\n')), board, interact })

    expect(result.code).toBe(0)
    expect(sessions[0]?.args.join(' ')).toContain('--model sonnet')
    expect(sessions[0]?.args.at(-1)).toContain('Which database?')
    expect(sessions[0]?.args.at(-1)).toContain('the plan')
    const last = (await board.listComments(task.id)).at(-1)?.body ?? ''
    expect(last.startsWith('<!-- conveyor')).toBe(false)
    expect(last).toContain('Use Postgres with a users table.')
  })

  it('refuses a task that does not wait for input', async () => {
    const board = new FakeBoard('me')
    await board.createTask('Running', 'p', 'in-progress')
    const result = await runCli(['attach', '1'], { ...(await project()), board, interact: agent('x').interact })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('does not wait for input')
  })

  it('posts nothing when the session ends without an answer', async () => {
    const board = new FakeBoard('me')
    const task = await waitingTask(board)
    const before = (await board.listComments(task.id)).length
    const result = await runCli(['attach', task.id], { ...(await project()), board, interact: agent().interact })
    expect(result.code).toBe(1)
    expect(await board.listComments(task.id)).toHaveLength(before)
  })
})
