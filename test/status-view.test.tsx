import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import type { StatusSnapshot } from '../src/status.js'
import { statusLines, usageLines } from '../src/ui/status-lines.js'
import { StatusScreen, type HubAction, type RunnerControl } from '../src/ui/status-screen.js'
import type { TaskControl } from '../src/ui/task-lines.js'
import type { RunnerEvent } from '../src/runner.js'
import { runCli } from './helpers.js'

const snapshot: StatusSnapshot = {
  settings: '/repo/.conveyor',
  project: 'acme/app',
  provider: 'github',
  me: 'me',
  runner: { running: false },
  settingsSync: { state: 'current' },
  undescribed: [],
  mine: [
    { id: '3', title: 'Store users', url: 'https://example.test/issues/3', state: 'needs-input', stage: 'plan', attempt: 0, waitingSince: '2026-10-05T09:00:00.000Z', answered: false },
    { id: '4', title: 'Login', url: 'https://example.test/issues/4', state: 'in-progress', stage: 'implement', attempt: 1, lastError: 'tests are red' },
  ],
  backlog: [
    { id: '7', title: 'Dark mode', url: 'https://example.test/issues/7' },
    { id: '8', title: 'Search', url: 'https://example.test/issues/8', form: 'idea' },
    { id: '9', title: 'Export', url: 'https://example.test/issues/9', form: 'plan' },
  ],
  team: { unclaimed: 2, claimedByOthers: 1 },
  limits: {
    running: { used: 1, limit: 3 },
    awaitingMe: { used: 1, limit: 1 },
    awaitingReview: { used: 0, limit: 2 },
    dailyTokens: { used: 12345, limit: 0 },
    subscription: {
      claude: {
        fiveHour: { utilization: 0.93, resetsAt: '2026-10-05T14:00:00.000Z' },
        observedAt: '2026-10-05T10:00:00.000Z',
        fiveHourReserve: 10,
        sevenDayReserve: 15,
      },
    },
  },
}

describe('statusLines', () => {
  it('shows the board columns, the tasks of an open column, and no usage', () => {
    const closed = statusLines(snapshot, undefined, { column: 0, open: false, focus: 'columns', task: 0 })
    expect(closed.find((line) => line.text.startsWith('my board:'))?.text).toBe('my board: backlog 1|1|0|1 · in progress 1/3 · needs input 1/1 · review 0/2')
    expect(closed.some((line) => line.text.includes('tokens'))).toBe(false)
    const backlog = statusLines(snapshot, undefined, { column: 0, open: true, focus: 'columns', task: 0 }).map((line) => line.text)
    expect(backlog).toEqual(expect.arrayContaining(['  #7 Dark mode — no form', '  #8 Search — form::idea', '  #9 Export — form::plan']))
    const open = statusLines(snapshot, undefined, { column: 2, open: true, focus: 'columns', task: 0 }).map((line) => line.text)
    expect(open[open.findIndex((text) => text.startsWith('my board:')) + 1]).toContain('#3 Store users — stage::plan · waits for your answer')
    expect(statusLines(snapshot, undefined, { column: 3, open: true, focus: 'columns', task: 0 }).map((line) => line.text)).toContain('  no tasks in review')
    const selected = statusLines(snapshot, undefined, { column: 3, open: false, focus: 'columns', task: 0 }).find((line) => line.segments)?.segments?.find((segment) => segment.selected)
    expect(selected?.text).toBe('review 0/2')
    const focused = statusLines(snapshot, undefined, { column: 0, open: true, focus: 'tasks', task: 1 })
    expect(focused.find((line) => line.text.startsWith('›'))?.text).toBe('› #8 Search — form::idea')
  })

  it('shows a usage line for every harness in use', () => {
    const subscription = {
      codex: { reports: true, fiveHourReserve: 0, sevenDayReserve: 0 },
      opencode: { reports: false, fiveHourReserve: 0, sevenDayReserve: 0 },
    }
    const text = usageLines({ ...snapshot, limits: { ...snapshot.limits, subscription } }).map((line) => line.text)
    expect(text).toContain('codex: not seen yet; they appear after its first stage, or with limits.subscription.probe')
    expect(text).toContain('opencode: none; this harness does not report subscription windows')
  })

  it('warns about newer team settings', () => {
    const lines = statusLines({ ...snapshot, settingsSync: { state: 'behind', base: 'origin/main', commits: ['abc123 alice, 2 hours ago: Squash merges'] } })
    expect(lines[1]).toMatchObject({ text: expect.stringContaining('Team settings are behind origin/main by 1 commit'), tone: 'warning' })
    expect(lines[2]?.text).toContain('Squash merges')
  })

  it('shows the runner, limits, subscription windows, my tasks, and the team queue', () => {
    const lines = statusLines(snapshot)
    const text = lines.map((line) => line.text).join('\n')
    expect(text).toContain('acme/app (github) · @me · stopped')
    expect(text).toContain('needs input 1/1')
    expect(text).not.toContain('tokens today')
    expect(text).toContain('no new tasks: the claude subscription reserve reached · [u] usage')
    const usage = usageLines(snapshot).map((line) => line.text).join('\n')
    expect(usage).toContain('tokens today 12,345 (no daily limit)')
    expect(usage).toContain('claude: 5h 93% (reserve 10%')
    expect(text).toContain('needs input:')
    expect(text).toContain('#3 Store users — stage::plan')
    expect(text).toContain('waits for your answer')
    expect(text).toContain('attempt 2')
    expect(text).toContain('last error: tests are red')
    expect(text).toContain('Team: 2 unclaimed · 1 claimed by others')
    expect(lines.find((line) => line.text.includes('#4'))?.tone).toBe('error')
    expect(usageLines(snapshot).find((line) => line.text.startsWith('claude'))?.tone).toBe('warning')
  })
})

describe('StatusScreen', () => {
  it('renders the snapshot and reloads on r', async () => {
    const load = vi.fn(async () => snapshot)
    const { lastFrame, stdin } = render(<StatusScreen load={load} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    stdin.write('r')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2), { timeout: 5_000 })
  })

  it('toggles the help with h and scrolls it within the window', async () => {
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    stdin.write('h')
    await vi.waitFor(() => expect(lastFrame()).toContain('conveyor help'), { timeout: 5_000 })
    expect(lastFrame()).toContain('↑↓ scroll')
    const frame = lastFrame()?.split('\n') ?? []
    const more = frame.findIndex((line) => line.includes('↑↓ scroll') && line.startsWith('lines'))
    expect(frame[more - 1]?.trim()).toBe('')
    expect(frame[more + 1]?.trim()).toBe('')
    expect(frame[more + 2]).toContain('[Esc] back')
    expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(24)
    for (let step = 0; step < 40 && !lastFrame()?.includes('/fix_from: <stage>'); step++) {
      stdin.write('\u001B[B')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(lastFrame()).toContain('/fix_from: <stage>')
    expect(lastFrame()).not.toContain('conveyor help')
    expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(24)
    await new Promise((resolve) => setTimeout(resolve, 100))
    stdin.write('h')
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
  })

  it('shows a board error', async () => {
    const { lastFrame } = render(<StatusScreen load={async () => Promise.reject(new Error('gh: not logged in'))} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('Board error: gh: not logged in'), { timeout: 5_000 })
  })
})

function fakeRunner() {
  const listeners = new Set<() => void>()
  const runner = {
    running: false,
    events: [] as RunnerEvent[],
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: async () => {
      runner.running = true
      runner.events.push({ time: new Date().toISOString(), level: 'info', text: 'claimed task 7: Login' })
      for (const listener of listeners) listener()
      return { ok: true as const }
    },
    stop: async () => {
      runner.running = false
      for (const listener of listeners) listener()
    },
  }
  return runner satisfies RunnerControl
}

describe('StatusScreen as a control panel', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100))
  const DOWN = '\u001B[B'
  const RIGHT = '\u001B[C'
  const ESC = '\u001B'

  function control() {
    const calls: string[] = []
    const pull = { number: '52', url: 'https://example.test/pull/52', headSha: 'a', state: 'open' as const, checks: 'success' as const, mergeable: 'yes' as const, feedback: [], reviews: [], comments: [{ author: 'alice', body: 'Looks fine', createdAt: '2026-10-05T10:00:00.000Z' }] }
    const value: TaskControl = {
      openBoard: async () => void calls.push('open board'),
      updateBoard: async () => 'Nothing to add.',
      detail: async (id) => ({
        task: { id, title: id === '8' ? 'Search' : 'Store users', body: 'The task text', author: 'me', url: `https://example.test/issues/${id}`, assignees: [], openBlockers: 0, closed: false, createdAt: '', ...(id === '8' ? { state: 'backlog' as const, form: 'idea' as const } : { state: 'review' as const }) },
        workpad: { stage: 'plan', text: 'Notes of the agent' },
        comments: [{ id: 'c1', author: 'bob', body: 'Which date format?', createdAt: '2026-10-05T09:00:00.000Z', updatedAt: '' }],
        ...(id === '3' ? { pull } : {}),
      }),
      comment: async (id, target, body) => void calls.push(`comment ${id} ${target} ${body}`),
      toggleIdea: async (id) => {
        calls.push(`idea ${id}`)
        return `Removed form::idea from #${id}.`
      },
      open: async (url) => void calls.push(`open ${url}`),
    }
    return { value, calls }
  }

  it('moves into the tasks of a column, opens one with its text, workpad, and comments, and goes back', async () => {
    const { value } = control()
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} control={value} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write(DOWN)
    await vi.waitFor(() => expect(lastFrame()).toContain('› #7 Dark mode — no form'), { timeout: 5_000 })
    expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('[i] form::idea on/off')
    await settle()
    stdin.write(DOWN)
    await vi.waitFor(() => expect(lastFrame()).toContain('› #8 Search — form::idea'), { timeout: 5_000 })
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('The task text'), { timeout: 5_000 })
    expect(lastFrame()).toContain('Workpad · stage plan')
    expect(lastFrame()).toContain('Notes of the agent')
    expect(lastFrame()).toContain('Which date format?')
    expect(lastFrame()).toContain('form::idea')
    await settle()
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).toContain('› #8 Search'), { timeout: 5_000 })
  })

  it('keeps the task number in its own column and wraps the title and labels inside the second one', async () => {
    const long = { ...snapshot, backlog: [{ id: '123', title: 'Tournament rule system enforcement with inline rule creation and validation of every match result', url: 'https://example.test/issues/123', form: 'story' as const }] }
    const { lastFrame, stdin } = render(<StatusScreen load={async () => long} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write(DOWN)
    await vi.waitFor(() => expect(lastFrame()).toContain('› #123'), { timeout: 5_000 })
    const lines = lastFrame()?.split('\n') ?? []
    const row = lines.findIndex((line) => line.startsWith('› #123'))
    expect(lines[row]?.indexOf('Tournament')).toBe(7)
    expect(lines[row + 1]?.slice(0, 7).trim()).toBe('')
    expect(lines[row + 1]).toContain('form::story')
  })

  it('comments, opens the browser, and toggles form::idea on a backlog task', async () => {
    const { value, calls } = control()
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} control={value} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write(DOWN)
    await settle()
    stdin.write(DOWN)
    await vi.waitFor(() => expect(lastFrame()).toContain('› #8 Search'), { timeout: 5_000 })
    await settle()
    stdin.write('b')
    await vi.waitFor(() => expect(calls).toContain('open https://example.test/issues/8'), { timeout: 5_000 })
    await settle()
    stdin.write('i')
    await vi.waitFor(() => expect(lastFrame()).toContain('Removed form::idea from #8.'), { timeout: 5_000 })
    await settle()
    stdin.write('c')
    await vi.waitFor(() => expect(lastFrame()).toContain('Comment on #8'), { timeout: 5_000 })
    await settle()
    stdin.write('Needs a design')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(calls).toContain('comment 8 issue Needs a design'), { timeout: 5_000 })
  })

  it('switches an opened review task to its pull request and comments there', async () => {
    const { value, calls } = control()
    const review = { ...snapshot, mine: [...snapshot.mine, { id: '3', title: 'Store users', url: 'https://example.test/issues/3', state: 'review' as const, attempt: 0, pullRequest: 'https://example.test/pull/52' }] }
    const { lastFrame, stdin } = render(<StatusScreen load={async () => review} refreshMs={60_000} control={value} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    for (const key of [RIGHT, RIGHT, RIGHT, DOWN, '\r']) {
      await settle()
      stdin.write(key)
    }
    await vi.waitFor(() => expect(lastFrame()).toContain('[p] pull request'), { timeout: 5_000 })
    await settle()
    stdin.write('p')
    await vi.waitFor(() => expect(lastFrame()).toContain('Looks fine'), { timeout: 5_000 })
    await settle()
    stdin.write('b')
    await vi.waitFor(() => expect(calls).toContain('open https://example.test/pull/52'), { timeout: 5_000 })
    await settle()
    stdin.write('c')
    await settle()
    stdin.write('/approve')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(calls).toContain('comment 3 pull /approve'), { timeout: 5_000 })
  })

  it('shows the board check on k and adds what is missing on Enter', async () => {
    const { value, calls } = control()
    value.updateBoard = async () => {
      calls.push('update board')
      return 'Added conveyor::backlog.'
    }
    const check = { ...snapshot, board: { missing: ['conveyor::backlog'], unused: ['conveyor::plan'], outdated: [{ id: '5', title: 'Old', labels: ['conveyor::plan'] }] } }
    const { lastFrame, stdin } = render(<StatusScreen load={async () => check} refreshMs={60_000} control={value} />)
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('the board differs from what this version uses: 1 labels missing · 1 tasks with old labels · [k] board check'), { timeout: 5_000 })
    await settle()
    stdin.write('k')
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('#5 Old has labels this version does not use'), { timeout: 5_000 })
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Added conveyor::backlog.'), { timeout: 5_000 })
    expect(calls).toContain('update board')
  })

  it('hands a task to the harness and opens the board in the browser', async () => {
    const { value, calls } = control()
    const actions: HubAction[] = []
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} control={value} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('b')
    await vi.waitFor(() => expect(calls).toContain('open board'), { timeout: 5_000 })
    for (const key of [DOWN, 'h']) {
      await settle()
      stdin.write(key)
    }
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'harness', id: '7' }]), { timeout: 5_000 })
  })
})

describe('StatusScreen as the hub', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

  it('moves between status columns with the arrows and lists their tasks with Enter', async () => {
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('\u001B[C')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('#4 Login — stage::implement'), { timeout: 5_000 })
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).not.toContain('#4 Login — stage::implement'), { timeout: 5_000 })
  })

  it('shows usage on u and goes back', async () => {
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('u')
    await vi.waitFor(() => expect(lastFrame()).toContain('tokens today 12,345'), { timeout: 5_000 })
    expect(lastFrame()).not.toContain('my board:')
    stdin.write('u')
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
  })

  it('starts and stops the conveyor with s and shows its log on o', async () => {
    const runner = fakeRunner()
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} runner={runner} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('[s] start conveyor'), { timeout: 5_000 })
    await settle()
    stdin.write('s')
    await vi.waitFor(() => expect(lastFrame()).toContain('running here'), { timeout: 5_000 })
    expect(lastFrame()).toContain('[s] stop conveyor')
    expect(lastFrame()).not.toContain('claimed task 7: Login')
    await settle()
    stdin.write('o')
    await vi.waitFor(() => expect(lastFrame()).toContain('claimed task 7: Login'), { timeout: 5_000 })
    expect(lastFrame()).toContain('full log ~/.conveyor/logs/acme-app.log')
    expect(lastFrame()).not.toContain('my board:')
    await settle()
    stdin.write('o')
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('s')
    await vi.waitFor(() => expect(lastFrame()).toContain('The conveyor stopped.'), { timeout: 5_000 })
  })

  it('wraps the second column of the help inside that column', async () => {
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('h')
    await vi.waitFor(() => expect(lastFrame()).toContain('conveyor help'), { timeout: 5_000 })
    for (let step = 0; step < 40 && !lastFrame()?.includes('this screen'); step++) {
      stdin.write('\u001B[B')
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    const lines = lastFrame()?.split('\n') ?? []
    const row = lines.findIndex((line) => line.startsWith('  this screen'))
    expect(lines[row]?.indexOf('b board in the browser')).toBe(28)
    expect(lines[row + 1]?.slice(0, 28).trim()).toBe('')
    expect(lines[row + 1]?.trim().length).toBeGreaterThan(0)
  })

  it('asks the conveyor-help skill from the help screen with a', async () => {
    const actions: HubAction[] = []
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('?')
    await vi.waitFor(() => expect(lastFrame()).toContain('[a] ask the conveyor-help skill'), { timeout: 5_000 })
    await settle()
    stdin.write('a')
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'help' }]), { timeout: 5_000 })
  })

  it('closes help, usage, and log with Esc and names the way back', async () => {
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    for (const [key, title] of [['h', 'conveyor help · [h] or Esc back'], ['u', 'Usage · [u] or Esc back'], ['o', '[o] or Esc back']] as const) {
      await settle()
      stdin.write(key)
      await vi.waitFor(() => expect(lastFrame()).toContain(title), { timeout: 5_000 })
      const lines = lastFrame()?.split('\n') ?? []
      const footer = lines.findIndex((line) => line.includes('[Esc] back · [q] quit'))
      expect(lines[footer - 1]?.trim()).toBe('')
      await settle()
      stdin.write('\u001B')
      await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    }
    const lines = lastFrame()?.split('\n') ?? []
    expect(lines[lines.findIndex((line) => line.includes('[←→] column')) - 1]?.trim()).toBe('')
  })

  it('opens the settings with e', async () => {
    const actions: HubAction[] = []
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('e')
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'settings' }]), { timeout: 5_000 })
  })

  it('asks before quitting while the conveyor runs', async () => {
    const runner = fakeRunner()
    await runner.start()
    const actions: HubAction[] = []
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} runner={runner} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('running here'), { timeout: 5_000 })
    await settle()
    stdin.write('q')
    await vi.waitFor(() => expect(lastFrame()).toContain('Press q again'), { timeout: 5_000 })
    expect(actions).toEqual([])
    await settle()
    stdin.write('q')
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'quit' }]), { timeout: 5_000 })
  })

  it('asks for the task number of attach and release', async () => {
    const actions: HubAction[] = []
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('a')
    await vi.waitFor(() => expect(lastFrame()).toContain('Answer the questions of the task with issue number'), { timeout: 5_000 })
    expect(lastFrame()).toContain('#<issue number>')
    await settle()
    stdin.write('#51')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'attach', id: '51' }]), { timeout: 5_000 })
  })

  it('opens the live session for a new task with n', async () => {
    const actions: HubAction[] = []
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('[n] new'), { timeout: 5_000 })
    await settle()
    stdin.write('n')
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'new' }]), { timeout: 5_000 })
  })
})

describe('conveyor without arguments', () => {
  it('prints the status as JSON', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const board = new FakeBoard('me')
    const task = await board.createTask('Mine', 'p', { state: 'in-progress' })
    await board.setOwner(task.id, 'me')
    const result = await runCli(['--json'], { cwd: init.context.cwd, home: init.context.home, board })
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ valid: true, status: { me: 'me', mine: [{ id: '1', state: 'in-progress' }] } })
  })

  it('prints a text summary without a terminal', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const result = await runCli([], { cwd: init.context.cwd, home: init.context.home, board: new FakeBoard('me') })
    expect(result.stdout).toContain('backlog:')
    expect(result.stdout).toContain('none')
  })
})
