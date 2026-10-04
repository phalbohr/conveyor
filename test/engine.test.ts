import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { loadConfig } from '../src/config.js'
import { Engine } from '../src/engine/engine.js'
import { UsageLedger } from '../src/usage.js'
import { FakeHarness, type Script } from '../src/harness/fake.js'
import type { StageResult } from '../src/harness/harness.js'
import { FakeWorkspaces, deferred } from './fakes.js'
import { tempDir } from './helpers.js'

type Setup = { config?: string; local?: string; script?: Script; instructions?: Record<string, string> }

function setup(options: Setup = {}) {
  const settings = tempDir('conveyor-settings-')
  const config = options.config ?? ''
  const stages = config.includes('stages:') ? '' : 'stages:\n  implement: {}\n  review: {}\n'
  writeFileSync(join(settings, 'config.yaml'), `board: {provider: github, project: acme/app}\n${config}${stages}`)
  if (options.local) writeFileSync(join(settings, 'local.yaml'), options.local)
  mkdirSync(join(settings, 'stages'))
  for (const [stage, text] of Object.entries(options.instructions ?? {})) writeFileSync(join(settings, 'stages', `${stage}.md`), text)
  const home = tempDir('conveyor-home-')
  const repo = tempDir('conveyor-repo-')
  const usage = new UsageLedger()
  const board = new FakeBoard('me')
  const harness = new FakeHarness(options.script)
  const workspaces = new FakeWorkspaces()
  const engine = new Engine({
    board,
    harnesses: { claude: harness, codex: harness },
    workspaces,
    settingsDir: settings,
    repo,
    usage,
    home,
    loadConfig: () => loadConfig(settings),
  })
  const cycle = async () => {
    await engine.tick()
    await engine.idle()
  }
  const runs = () => harness.runs.map((run) => `${run.taskId}:${run.stage}`)
  return { settings, home, repo, usage, board, harness, workspaces, engine, cycle, runs }
}

const done = (artifact?: { kind: string; content: string }): StageResult => ({ outcome: 'done', summary: 'ok', ...(artifact ? { artifact } : {}) })

const byStage =
  (results: Record<string, StageResult | ((index: number) => StageResult)>): Script =>
  (run, index) => {
    const result = results[run.stage ?? '']
    if (typeof result === 'function') return result(index)
    return result ?? done()
  }

describe('Engine stage chain', () => {
  it('runs a planned task through the stages after plan and stops for review', async () => {
    const { board, cycle, runs, harness, workspaces } = setup({
      config: 'stages:\n  implement: {model: sonnet, effort: medium}\n  review: {harness: codex, model: gpt, effort: high}\n',
    })
    const task = await board.createTask('Add login', 'plan text', 'plan')

    await cycle()

    expect(runs()).toEqual(['1:implement', '1:review', '1:merge'])
    expect(harness.runs[1]).toMatchObject({ model: 'gpt', effort: 'high' })
    expect(await board.getTask(task.id)).toMatchObject({ state: 'review', owner: 'me' })
    expect(await board.claim(task.id)).toBe(false)
    expect((await board.listComments(task.id)).filter((c) => c.body.includes('conveyor:workpad'))).toHaveLength(1)
    expect(workspaces.hooks).toEqual(['before_run:1', 'after_run:1', 'before_run:1', 'after_run:1', 'before_run:1', 'after_run:1'])
  })

  it('commits the changes of each stage before pushing', async () => {
    const { board, cycle, workspaces } = setup({ script: () => ({ outcome: 'done', summary: 'did the work\nwith details' }) })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect(workspaces.stageCommits).toEqual(['1:implement: did the work', '1:review: did the work', '1:merge: did the work'])
  })

  it('puts stage instructions, task, and workpad into the prompt', async () => {
    const { board, cycle, harness } = setup({
      instructions: { implement: 'Write the code test-first.' },
      script: byStage({ implement: { outcome: 'done', summary: 'ok', workpad: '- [x] step one' } }),
    })
    await board.createTask('Add login', 'the plan body', 'plan')

    await cycle()

    expect(harness.runs[0]?.prompt).toContain('Write the code test-first.')
    expect(harness.runs[0]?.prompt).toContain('the plan body')
    expect(harness.runs[1]?.prompt).toContain('- [x] step one')
  })

  it('asks for approval of a story in interactive mode', async () => {
    const { board, cycle, runs } = setup({
      config: 'pickup_from: idea\n',
      script: byStage({ story: done({ kind: 'story', content: 'As a user, I want to log in.' }) }),
    })
    const task = await board.createTask('Login', 'idea: login', 'idea')

    await cycle()

    expect(runs()).toEqual(['1:story'])
    expect(await board.getTask(task.id)).toMatchObject({ state: 'needs-input', body: 'As a user, I want to log in.' })
    expect((await board.listComments(task.id)).at(-1)?.body).toContain('approval')
  })

  it('continues after the approval reply and asks for plan approval', async () => {
    const { board, cycle, runs, harness } = setup({
      config: 'pickup_from: idea\n',
      script: byStage({
        story: done({ kind: 'story', content: 'the story' }),
        plan: done({ kind: 'plan', content: 'the plan' }),
      }),
    })
    const task = await board.createTask('Login', 'idea', 'idea')
    await cycle()
    await board.addComment(task.id, 'Looks good, approved.')

    await cycle()

    expect(runs()).toEqual(['1:story', '1:story', '1:plan'])
    expect(harness.runs[1]?.prompt).toContain('Looks good, approved.')
    expect(await board.getTask(task.id)).toMatchObject({ state: 'needs-input' })
    expect((await board.listComments(task.id)).some((c) => c.body.includes('conveyor:artifact:plan') && c.body.includes('the plan'))).toBe(true)
  })

  it('does not resume a task without an answer', async () => {
    const { board, cycle, runs } = setup({ config: 'pickup_from: idea\n' })
    await board.createTask('Login', 'idea', 'idea')
    await cycle()
    await cycle()
    expect(runs()).toEqual(['1:story'])
  })

  it('runs the full chain in autonomous mode', async () => {
    const { board, cycle, runs } = setup({
      config: 'pickup_from: idea\ntransitions: {idea_to_story: autonomous, story_to_plan: autonomous}\n',
      script: byStage({ story: done({ kind: 'story', content: 's' }), plan: done({ kind: 'plan', content: 'p' }) }),
    })
    const task = await board.createTask('Login', 'idea', 'idea')

    await cycle()

    expect(runs()).toEqual(['1:story', '1:plan', '1:implement', '1:review', '1:merge'])
    expect((await board.getTask(task.id))?.state).toBe('review')
  })

  it('posts questions and resumes the stage with the answer', async () => {
    const { board, cycle, runs, harness } = setup({
      script: byStage({
        implement: (index) => (index === 0 ? { outcome: 'needs_input', summary: 'unclear', questions: ['Which database?'] } : done()),
      }),
    })
    const task = await board.createTask('Store users', 'plan', 'plan')
    await cycle()
    expect((await board.getTask(task.id))?.state).toBe('needs-input')
    expect((await board.listComments(task.id)).at(-1)?.body).toContain('Which database?')

    await board.addComment(task.id, 'Use Postgres.')
    await cycle()

    expect(runs()).toEqual(['1:implement', '1:implement', '1:review', '1:merge'])
    expect(harness.runs[1]?.prompt).toContain('Which database?')
    expect(harness.runs[1]?.prompt).toContain('Use Postgres.')
  })

  it('accepts approval in autonomous mode as done', async () => {
    const { board, cycle, runs } = setup({
      config: 'pickup_from: story\ntransitions: {story_to_plan: autonomous}\n',
      script: byStage({ plan: { outcome: 'approval', summary: 'ok', artifact: { kind: 'plan', content: 'p' } } }),
    })
    await board.createTask('Login', 'story', 'story')
    await cycle()
    expect(runs()).toEqual(['1:plan', '1:implement', '1:review', '1:merge'])
  })

  it('ignores story tasks when the pickup point is plan', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Login', 'story', 'story')
    await cycle()
    expect(runs()).toEqual([])
  })
})

describe('Engine artifacts', () => {
  it('appends the story to the idea when configured', async () => {
    const { board, cycle } = setup({
      config: 'pickup_from: idea\nartifacts: {story: {write: append}}\ntransitions: {idea_to_story: autonomous}\n',
      script: byStage({ story: done({ kind: 'story', content: 'the story' }), plan: { outcome: 'needs_input', summary: 'q', questions: ['?'] } }),
    })
    const task = await board.createTask('Login', 'the idea', 'idea')
    await cycle()
    expect((await board.getTask(task.id))?.body).toBe('the idea\n\n---\n\nthe story')
  })

  it('stores a private plan in a personal directory', async () => {
    const { board, cycle, home } = setup({
      config: 'pickup_from: story\ntransitions: {story_to_plan: autonomous}\nartifacts: {plan: {store: repo, path: docs/plans, allow_private: true}}\n',
      local: 'artifacts:\n  plan: {store: path, path: "~/Plans/{project}"}\n',
      script: byStage({ plan: done({ kind: 'plan', content: '# Plan' }), implement: { outcome: 'needs_input', summary: 'q', questions: ['?'] } }),
    })
    const task = await board.createTask('Login', 'story', 'story')
    await cycle()
    expect(readFileSync(join(home, 'Plans', 'acme-app', `${task.id}-plan.md`), 'utf8')).toBe('# Plan')
  })

  it('commits a repository plan to the task branch and shows it to later stages', async () => {
    const { board, cycle, workspaces, harness } = setup({
      config: 'pickup_from: story\ntransitions: {story_to_plan: autonomous}\nartifacts: {plan: {store: repo, path: docs/plans}}\n',
      script: byStage({ plan: done({ kind: 'plan', content: '# Repo plan' }) }),
    })
    await board.createTask('Login', 'story', 'story')
    await cycle()
    expect(workspaces.commits).toEqual([{ taskId: '1', file: 'docs/plans/1-plan.md', content: '# Repo plan' }])
    expect(harness.runs[1]?.prompt).toContain('# Repo plan')
  })
})

describe('Engine scheduling', () => {
  it('respects the running limit', async () => {
    const gate = deferred<StageResult>()
    const { board, engine, runs } = setup({
      local: 'limits: {running: 1}\n',
      script: (run) => (run.taskId === '1' && run.stage === 'implement' ? gate.promise : done()),
    })
    await board.createTask('First', 'p', 'plan')
    await board.createTask('Second', 'p', 'plan')

    await engine.tick()
    await vi.waitFor(() => expect(runs()).toEqual(['1:implement']))
    await engine.tick()
    expect(runs()).toEqual(['1:implement'])

    gate.resolve(done())
    await engine.idle()
    await engine.tick()
    await engine.idle()
    expect(runs()).toEqual(['1:implement', '1:review', '1:merge', '2:implement', '2:review', '2:merge'])
  })

  it('does not claim new tasks when too many tasks wait for me', async () => {
    const { board, cycle, runs } = setup({
      local: 'limits: {awaiting_me: 1}\n',
      script: byStage({ implement: { outcome: 'needs_input', summary: 'q', questions: ['?'] } }),
    })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    await board.createTask('Second', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement'])
  })

  it('does not claim new tasks when too many tasks wait for my review', async () => {
    const { board, cycle, runs } = setup({ local: 'limits: {awaiting_review: 1}\n' })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    await board.createTask('Second', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:review', '1:merge'])
  })

  it('resumes answered tasks first and queues the rest', async () => {
    const gate = deferred<StageResult>()
    let asked = 0
    const { board, engine, cycle, runs } = setup({
      local: 'limits: {running: 1, awaiting_me: 5}\n',
      script: (run) => {
        if (run.stage !== 'implement') return done()
        if (asked < 2) {
          asked++
          return { outcome: 'needs_input', summary: 'q', questions: ['?'] }
        }
        return gate.promise
      },
    })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    await board.createTask('Second', 'p', 'plan')
    await cycle()
    await board.createTask('Third', 'p', 'plan')
    await board.addComment('1', 'answer one')
    await board.addComment('2', 'answer two')

    await engine.tick()

    await vi.waitFor(() => expect(runs().slice(2)).toEqual(['1:implement']))
    expect((await board.getTask('2'))?.state).toBe('queued')
    expect((await board.getTask('3'))?.state).toBe('plan')
    gate.resolve(done())
    await engine.idle()
  })

  it('skips a task claimed by another workstation', async () => {
    const { board, cycle, runs } = setup()
    await board.createTask('Taken', 'p', 'plan')
    await board.claim('1')
    await cycle()
    expect(runs()).toEqual([])
  })

  it('takes my tasks first, then unassigned tasks by priority and age, and skips others and blocked tasks', async () => {
    const { board, cycle, runs } = setup({ local: 'limits: {running: 1, awaiting_review: 10}\n' })
    await board.createTask('old unassigned', 'p', 'plan')
    await board.createTask('urgent unassigned', 'p', 'plan')
    board.addLabel('2', 'priority::1')
    await board.createTask('mine', 'p', 'plan')
    board.assign('3', 'me')
    await board.createTask('theirs', 'p', 'plan')
    board.assign('4', 'alice')
    await board.createTask('blocked', 'p', 'plan')
    board.addLabel('5', 'priority::1')
    await board.addBlocker('5', '1')

    for (let i = 0; i < 4; i++) await cycle()
    expect(runs().filter((run) => run.endsWith(':implement'))).toEqual(['3:implement', '2:implement', '1:implement'])

    await board.closeTask('1')
    await cycle()
    expect(runs().filter((run) => run.endsWith(':implement'))).toEqual(['3:implement', '2:implement', '1:implement', '5:implement'])
  })

  it('takes only assigned tasks when unassigned tasks are excluded', async () => {
    const { board, cycle, runs } = setup({ local: 'pickup: {include_unassigned: false}\n' })
    await board.createTask('unassigned', 'p', 'plan')
    await board.createTask('mine', 'p', 'plan')
    board.assign('2', 'me')
    await cycle()
    expect(runs().filter((run) => run.endsWith(':implement'))).toEqual(['2:implement'])
  })

  it('does not claim anything with an invalid configuration', async () => {
    const { board, cycle, runs, settings } = setup()
    writeFileSync(join(settings, 'config.yaml'), 'board: {provider: jira, project: x}\n')
    await board.createTask('Login', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual([])
  })

  it('fails the stage when the before_run hook fails', async () => {
    const { board, cycle, runs, workspaces } = setup()
    workspaces.failBeforeRun = true
    await board.createTask('Login', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual([])
    expect((await board.listComments('1')).find((c) => c.body.includes('conveyor:workpad'))?.body).toContain('"attempt":1')
  })
})

describe('Engine stage files', () => {
  it('renders template variables in the stage instructions', async () => {
    const { board, cycle, harness } = setup({ instructions: { implement: 'Implement #{{ issue.id }} "{{ issue.title }}" in {{ stage }}.' } })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect(harness.runs[0]?.prompt).toContain('Implement #1 "Add login" in implement.')
  })

  it('does not start a stage with an unknown template variable and asks a human at once', async () => {
    const { board, cycle, runs } = setup({ instructions: { implement: 'Owner: {{ issue.owner }}' } })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual([])
    expect((await board.getTask('1'))?.state).toBe('needs-input')
    expect((await board.listComments('1')).at(-1)?.body).toContain('issue.owner')
  })

  it('does not start a stage with a missing skill', async () => {
    const { board, cycle, runs } = setup({ instructions: { implement: '---\nskills: [grilling]\n---\nUse grilling.' } })
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual([])
    const last = (await board.listComments('1')).at(-1)?.body
    expect(last).toContain('grilling')
    expect(last).toContain('implement')
  })

  it('passes the resolved skills to the harness', async () => {
    const { board, cycle, harness, home } = setup({ instructions: { implement: '---\nskills: [grilling]\n---\nUse grilling.' } })
    mkdirSync(join(home, '.claude', 'skills', 'grilling'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'grilling', 'SKILL.md'), '---\nname: grilling\n---\n')
    await board.createTask('Add login', 'p', 'plan')
    await cycle()
    expect(harness.runs[0]?.skills).toEqual([{ name: 'grilling', source: 'personal', dir: join(home, '.claude', 'skills', 'grilling') }])
  })
})

describe('Engine language and formats', () => {
  it('asks for team-visible output in the documentation language', async () => {
    const { board, cycle, harness } = setup({ config: 'language: {docs: German}\n', local: 'language: {chat: Russian}\n' })
    await board.createTask('Login', 'p', 'plan')
    await cycle()
    expect(harness.runs[0]?.prompt).toContain('German')
    expect(harness.runs[0]?.prompt).not.toContain('Russian')
  })

  it('gives stage templates the story format and the documentation language', async () => {
    const { board, cycle, harness, settings } = setup({
      config: 'pickup_from: idea\n',
      instructions: { story: 'Write in {{ language.docs }}.\n\n{{ formats.story }}' },
    })
    mkdirSync(join(settings, 'formats'))
    writeFileSync(join(settings, 'formats', 'story.md'), '**Story:** As a <role>...')
    await board.createTask('Login', 'idea', 'idea')
    await cycle()
    expect(harness.runs[0]?.prompt).toContain('Write in English.')
    expect(harness.runs[0]?.prompt).toContain('**Story:** As a <role>...')
  })
})

describe('Engine token budget', () => {
  it('stops claiming new tasks when the daily token limit is reached', async () => {
    const { board, cycle, runs, usage } = setup({ local: 'limits: {daily_tokens: 300, awaiting_review: 10}\n' })
    await board.createTask('First', 'p', 'plan')
    await cycle()
    expect(usage.today()).toBe(330)
    await board.createTask('Second', 'p', 'plan')
    await cycle()
    expect(runs()).toEqual(['1:implement', '1:review', '1:merge'])
  })
})
