import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import type { StatusSnapshot } from '../src/status.js'
import { arrivedColumns, columnTasks, statusLines, usageLines } from '../src/ui/status-lines.js'
import { StatusScreen, type HubAction, type RunnerControl } from '../src/ui/status-screen.js'
import type { TaskControl } from '../src/ui/task-lines.js'
import { dateTime } from '../src/ui/time.js'
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
        reports: true,
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
    expect(closed.find((line) => line.text.startsWith('my board:'))?.text).toBe('my board: backlog 1|1|0|1 · in progress 1/3 · queued 0 · needs input 1/1 · review 0/2')
    expect(closed.some((line) => line.text.includes('tokens'))).toBe(false)
    const backlog = statusLines(snapshot, undefined, { column: 0, open: true, focus: 'columns', task: 0 }).map((line) => line.text)
    expect(backlog).toEqual(expect.arrayContaining(['  #7 Dark mode — no form', '  #8 Search — form::idea', '  #9 Export — form::plan']))
    const open = statusLines(snapshot, undefined, { column: 3, open: true, focus: 'columns', task: 0 }).map((line) => line.text)
    expect(open[open.findIndex((text) => text.startsWith('my board:')) + 1]).toContain('#3 Store users — stage::plan · waits for your answer')
    expect(statusLines(snapshot, undefined, { column: 4, open: true, focus: 'columns', task: 0 }).map((line) => line.text)).toContain('  no tasks in review')
    const queued = { ...snapshot, mine: [...snapshot.mine, { id: '6', title: 'Answered', url: 'https://example.test/issues/6', state: 'queued' as const, stage: 'plan', attempt: 0 }] }
    expect(columnTasks(queued, 2).map((task) => task.id)).toEqual(['6'])
    expect(columnTasks(queued, 3).map((task) => task.id)).toEqual(['3'])
    const selected = statusLines(snapshot, undefined, { column: 4, open: false, focus: 'columns', task: 0 }).find((line) => line.segments)?.segments?.find((segment) => segment.selected)
    expect(selected?.text).toBe('review 0/2')
    const focused = statusLines(snapshot, undefined, { column: 0, open: true, focus: 'tasks', task: 1 })
    expect(focused.find((line) => line.text.startsWith('›'))?.text).toBe('› #8 Search — form::idea')
    const board = focused.find((line) => line.segments)?.segments ?? []
    expect(board.filter((segment) => segment.marked).map((segment) => segment.text)).toEqual([expect.stringMatching(/^backlog /)])
    expect(board.some((segment) => segment.selected)).toBe(false)
  })

  it('names the columns that got a new task and highlights their headers', () => {
    const review = { ...snapshot, mine: [...snapshot.mine, { id: '5', title: 'Profile', url: 'https://example.test/issues/5', state: 'review' as const, stage: 'merge', attempt: 0 }] }
    const moved = { ...snapshot, mine: snapshot.mine.filter((task) => task.id !== '3') }
    expect(arrivedColumns(undefined, snapshot)).toEqual([])
    expect(arrivedColumns(snapshot, review)).toEqual([4])
    expect(arrivedColumns(snapshot, moved)).toEqual([])
    const segments = statusLines(review, undefined, undefined, [4]).find((line) => line.segments)?.segments ?? []
    expect(segments.filter((segment) => segment.flash).map((segment) => segment.text)).toEqual(['review 0/2'])
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
    cycles: 0,
    cycle: () => (runner.running ? (runner.cycles++, true) : false),
    finishing: false,
    drain: () => {
      runner.finishing = true
      for (const listener of listeners) listener()
    },
  }
  return runner satisfies RunnerControl
}

describe('StatusScreen as a control panel', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100))
  const DOWN = '\u001B[B'
  const UP = '\u001B[A'
  const RIGHT = '\u001B[C'
  const ESC = '\u001B'

  function control(session: { enabled: boolean; lines: string[] } = { enabled: false, lines: [] }) {
    const calls: string[] = []
    const pull = { number: '52', url: 'https://example.test/pull/52', headSha: 'a', state: 'open' as const, checks: 'success' as const, mergeable: 'yes' as const, feedback: [], reviews: [], comments: [{ author: 'alice', body: 'Looks fine', createdAt: '2026-10-05T10:00:00.000Z' }] }
    const value: TaskControl = {
      openBoard: async () => void calls.push('open board'),
      updateBoard: async () => 'Nothing to add.',
      session: (id) => ({ ...session, file: `/home/me/.conveyor/sessions/acme-app/${id}.log` }),
      detail: async (id) => ({
        task: { id, title: id === '8' ? 'Search' : 'Store users', body: 'The task text', author: 'me', url: `https://example.test/issues/${id}`, labels: [], assignees: [], openBlockers: 0, closed: false, createdAt: '', ...(id === '8' ? { state: 'backlog' as const, form: 'idea' as const } : { state: 'review' as const }) },
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
      reset: async (id, form) => {
        calls.push(`reset ${id} ${form}`)
        return `Reset #${id}.`
      },
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

  it('watches the session of a task, scrolls back, follows again, and returns', async () => {
    const lines = ['10:00:00 ── implement · claude · attempt 1 · 2026-10-12 ──', ...Array.from({ length: 60 }, (_, index) => `10:00:${String(index).padStart(2, '0')} ▸ Bash step ${index}`), '10:01:00   ✗ exit 1']
    const { value } = control({ enabled: true, lines })
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} control={value} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write(DOWN)
    await vi.waitFor(() => expect(lastFrame()).toContain('› #7 Dark mode'), { timeout: 5_000 })
    expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('[w] watch')
    await settle()
    stdin.write('w')
    await vi.waitFor(() => expect(lastFrame()).toContain('Watch #7 · follows the stage · ~/.conveyor/sessions/acme-app/7.log'), { timeout: 5_000 })
    expect(lastFrame()).toContain('✗ exit 1')
    expect(lastFrame()).not.toContain('step 0\n')
    await settle()
    stdin.write(UP)
    await vi.waitFor(() => expect(lastFrame()).toContain('paused, ↓ at the end follows again'), { timeout: 5_000 })
    expect(lastFrame()).not.toContain('✗ exit 1')
    await settle()
    stdin.write(DOWN)
    await vi.waitFor(() => expect(lastFrame()).toContain('follows the stage'), { timeout: 5_000 })
    await settle()
    stdin.write('w')
    await vi.waitFor(() => expect(lastFrame()).toContain('› #7 Dark mode'), { timeout: 5_000 })
  })

  it('says how to turn session logs on when they are off', async () => {
    const { value } = control()
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} control={value} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write(DOWN)
    await vi.waitFor(() => expect(lastFrame()).toContain('› #7 Dark mode'), { timeout: 5_000 })
    await settle()
    stdin.write('w')
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('session logs are off: turn on "Session logs for watch" in [e] settings'), { timeout: 5_000 })
  })

  it('says that r reads the board again and when it is done', async () => {
    let loads = 0
    const { lastFrame, stdin } = render(<StatusScreen load={async () => (loads++, snapshot)} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Board read again at'), { timeout: 5_000 })
    expect(loads).toBe(2)
  })

  it('finishes the running stages on the first s and stops at once on the second', async () => {
    const runner = fakeRunner()
    runner.running = true
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} runner={runner} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('s')
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('Finishing: the running stages end'), { timeout: 5_000 })
    expect(runner.finishing).toBe(true)
    expect(runner.running).toBe(true)
    await settle()
    stdin.write('s')
    await vi.waitFor(() => expect(lastFrame()).toContain('The conveyor stopped.'), { timeout: 5_000 })
    expect(runner.running).toBe(false)
  })

  it('says when the running stages finished and the conveyor stopped', async () => {
    const runner = fakeRunner()
    runner.running = true
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} runner={runner} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('s')
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('Finishing: the running stages end'), { timeout: 5_000 })
    await runner.stop()
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('All running stages finished. The conveyor stopped.'), { timeout: 5_000 })
  })

  it('starts a conveyor cycle on r while the conveyor runs', async () => {
    const runner = fakeRunner()
    runner.running = true
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} runner={runner} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('r')
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('The conveyor starts a cycle now'), { timeout: 5_000 })
    expect(runner.cycles).toBe(1)
  })

  it('offers editor, one-line idea, and agent on n and creates an idea from one line', async () => {
    const actions: HubAction[] = []
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write('n')
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('[e] write title, form, and text in your editor'), { timeout: 5_000 })
    await settle()
    stdin.write('i')
    await vi.waitFor(() => expect(lastFrame()).toContain('New idea (form::idea)'), { timeout: 5_000 })
    await settle()
    stdin.write('Dark mode')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'idea', title: 'Dark mode' }]), { timeout: 5_000 })
  })

  it('resets a task in progress after the form is chosen', async () => {
    const { value, calls } = control()
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} control={value} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my board:'), { timeout: 5_000 })
    await settle()
    stdin.write(RIGHT)
    await settle()
    stdin.write(DOWN)
    await vi.waitFor(() => expect(lastFrame()).toContain('› #4 Login'), { timeout: 5_000 })
    expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('[x] reset')
    await settle()
    stdin.write('x')
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('Reset #4: stop its stage'), { timeout: 5_000 })
    expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('[s] story')
    await settle()
    stdin.write('s')
    await vi.waitFor(() => expect(calls).toContain('reset 4 story'), { timeout: 5_000 })
    await vi.waitFor(() => expect(lastFrame()).toContain('Reset #4.'), { timeout: 5_000 })
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
    await vi.waitFor(() => expect(lastFrame()?.replace(/\s+/g, ' ')).toContain('Finishing: the running stages end'), { timeout: 5_000 })
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
    for (const [key, title] of [['h', 'conveyor help · [h] or [Esc] back'], ['u', 'Usage · [u] or [Esc] back'], ['o', '[o] or [Esc] back']] as const) {
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

  it('opens the live harness session for a new task with n and h, and the editor with n and e', async () => {
    const actions: HubAction[] = []
    const first = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(first.lastFrame()).toContain('[n] new'), { timeout: 5_000 })
    await settle()
    first.stdin.write('n')
    await settle()
    first.stdin.write('h')
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'new' }]), { timeout: 5_000 })
    const second = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} onAction={(action) => actions.push(action)} />)
    await vi.waitFor(() => expect(second.lastFrame()).toContain('[n] new'), { timeout: 5_000 })
    await settle()
    second.stdin.write('n')
    await settle()
    second.stdin.write('e')
    await vi.waitFor(() => expect(actions).toEqual([{ kind: 'new' }, { kind: 'write' }]), { timeout: 5_000 })
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

describe('liveness of tasks in progress', () => {
  const at = (iso: string) => vi.setSystemTime(new Date(iso))
  const login = (status: StatusSnapshot) => columnTasks(status, 1).find((task) => task.id === '4')

  it('shows a stage running here with its last output', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    at('2026-10-05T10:05:00.000Z')
    const activity = { stage: 'implement', startedAt: '2026-10-05T10:00:00.000Z', lastOutputAt: '2026-10-05T10:04:50.000Z' }
    const running = { ...snapshot, runner: { running: true, pid: 7, here: true }, mine: snapshot.mine.map((task) => (task.id === '4' ? { ...task, activity } : task)) }
    expect(login(running)).toMatchObject({ detail: expect.stringContaining('● running here 5m · active 10s ago'), tone: 'ok' })
    expect(login(running)?.detail).not.toMatch(/attempt|last error/)

    at('2026-10-05T10:08:00.000Z')
    expect(login(running)).toMatchObject({ detail: expect.stringContaining('no activity for 3m'), tone: 'warning' })
    vi.useRealTimers()
  })

  it('tells a stopped conveyor from a run in another process', () => {
    expect(login(snapshot)?.detail).toContain('○ not running: [s] starts the conveyor')
    const elsewhere = { ...snapshot, runner: { running: true, pid: 42 }, mine: snapshot.mine.map((task) => (task.id === '4' ? { ...task, heartbeat: new Date(Date.now() - 3 * 60_000).toISOString() } : task)) }
    expect(login(elsewhere)?.detail).toContain('runs in conveyor pid 42 · heartbeat 3m ago')
  })

  it('shows a due retry as a resume instead of a past time', () => {
    const due = (running: boolean) => ({ ...snapshot, runner: { running, here: true }, mine: snapshot.mine.map((task) => (task.id === '4' ? { ...task, retryAt: '2026-10-11T16:23:00.000Z' } : task)) })
    expect(login(due(false))?.detail).toContain('resumes on start')
    expect(login(due(true))?.detail).toContain('resumes next cycle')
    expect(login(due(true))?.detail).not.toContain('retry 11.10.')
    const later = { ...snapshot, mine: snapshot.mine.map((task) => (task.id === '4' ? { ...task, retryAt: new Date(Date.now() + 60 * 60_000).toISOString() } : task)) }
    expect(login(later)?.detail).toMatch(/retry \d\d\.\d\d\. \d\d:\d\d/)
  })

  it('names the task that fixes the CI and marks my waiting tasks in every column', () => {
    const held = 'waits: task #9 fixes the CI first'
    const frozen = {
      ...snapshot,
      runner: { running: true, here: true },
      freeze: { id: '9', title: 'Fix the CI of the base branch main', base: true, owner: 'alice', waitingSince: '2026-10-13T09:12:00.000Z', private: true },
      mine: [
        { id: '4', title: 'Login', url: 'https://example.test/issues/4', state: 'in-progress' as const, attempt: 0, stage: 'land', held },
        { id: '5', title: 'Search', url: 'https://example.test/issues/5', state: 'queued' as const, attempt: 0, held },
        { id: '6', title: 'Profile', url: 'https://example.test/issues/6', state: 'needs-input' as const, attempt: 0, answered: true, held },
      ],
    }
    expect(statusLines(frozen).map((line) => line.text).join('\n')).toContain(`CI freeze: #9 Fix the CI of the base branch main fixes the CI (@alice, waits for an answer since ${dateTime('2026-10-13T09:12:00.000Z')}, private artifact) · new tasks and merges wait · stuck? \`conveyor release 9 --force\` hands it to another workstation`)
    expect(columnTasks(frozen, 1)[0]?.detail).toContain(`○ ${held}`)
    expect(columnTasks(frozen, 2)[0]?.detail).toBe(held)
    expect(columnTasks(frozen, 3)[0]?.detail).toBe(`answered, ${held}`)
  })

  it('shows why a parked task waits instead of the next attempt', () => {
    const parked = { ...snapshot, runner: { running: true, here: true }, mine: snapshot.mine.map((task) => (task.id === '4' ? { ...task, stage: 'land', parked: 'merge waits: the base branch CI is red; task #9 fixes it first' } : task)) }
    expect(login(parked)?.detail).toContain('stage::land · ○ merge waits: the base branch CI is red; task #9 fixes it first')
    expect(login(parked)?.detail).not.toContain('waits for its next attempt')
  })
})

describe('released tasks in the backlog', () => {
  it('counts them apart and shows where they resume', () => {
    const status = { ...snapshot, backlog: [{ id: '5', title: 'Pool v2', url: 'https://example.test/issues/5', released: { state: 'in-progress' as const, stage: 'plan' } }, ...snapshot.backlog] }
    expect(statusLines(status).map((line) => line.text).join('\n')).toContain('backlog 1|1|0|1 +1 released')
    expect(columnTasks(status, 0)[0]).toMatchObject({ id: '5', released: true, detail: expect.stringContaining('released · resumes at stage::plan (conveyor::in-progress) before new tasks') })
  })
})
