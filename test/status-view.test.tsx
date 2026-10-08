import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import type { StatusSnapshot } from '../src/status.js'
import { statusLines } from '../src/ui/status-lines.js'
import { StatusScreen, type HubAction, type RunnerControl } from '../src/ui/status-screen.js'
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
    { id: '3', title: 'Store users', state: 'needs-input', stage: 'plan', attempt: 0, waitingSince: '2026-10-05T09:00:00.000Z', answered: false },
    { id: '4', title: 'Login', state: 'in-progress', stage: 'implement', attempt: 1, lastError: 'tests are red' },
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
  it('shows my status columns, the tasks of an open column, and usage on its own line', () => {
    const closed = statusLines(snapshot)
    expect(closed.find((line) => line.text.startsWith('my status:'))?.text).toBe('my status: in progress 1/3 · needs input 1/1 · review 0/2')
    expect(closed.some((line) => line.text.startsWith('my status') && line.text.includes('tokens'))).toBe(false)
    expect(closed.find((line) => line.text.startsWith('usage:'))?.text).toBe('usage: tokens today 12,345')
    const open = statusLines(snapshot, undefined, { column: 1, open: true }).map((line) => line.text)
    const at = open.findIndex((text) => text.startsWith('my status:'))
    expect(open[at + 1]).toBe('  #3 Store users — plan')
    const review = statusLines(snapshot, undefined, { column: 2, open: true }).map((line) => line.text)
    expect(review).toContain('  no tasks review')
    const selected = statusLines(snapshot, undefined, { column: 2, open: false }).find((line) => line.segments)?.segments?.find((segment) => segment.selected)
    expect(selected?.text).toBe('review 0/2')
  })

  it('explains missing subscription windows', () => {
    const text = statusLines({ ...snapshot, limits: { ...snapshot.limits, subscription: {} } }).map((line) => line.text)
    expect(text).toContain('subscription windows: not seen yet; they appear after a claude stage runs, or turn on limits.subscription.probe')
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
    expect(text).toContain('tokens today 12,345')
    expect(text).toContain('claude: 5h 93% (reserve 10%')
    expect(text).toContain('#3 needs-input')
    expect(text).toContain('waiting for your answer')
    expect(text).toContain('attempt 2')
    expect(text).toContain('last error: tests are red')
    expect(text).toContain('Team: 2 unclaimed · 1 claimed by others')
    expect(lines.find((line) => line.text.includes('#4'))?.tone).toBe('error')
    expect(lines.find((line) => line.text.startsWith('claude'))?.tone).toBe('warning')
  })
})

describe('StatusScreen', () => {
  it('renders the snapshot and reloads on r', async () => {
    const load = vi.fn(async () => snapshot)
    const { lastFrame, stdin } = render(<StatusScreen load={load} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('#3 needs-input'), { timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    stdin.write('r')
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2), { timeout: 5_000 })
  })

  it('toggles the help with h', async () => {
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('#3 needs-input'), { timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    stdin.write('h')
    await vi.waitFor(() => expect(lastFrame()).toContain('/fix_from: <stage>'), { timeout: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    stdin.write('h')
    await vi.waitFor(() => expect(lastFrame()).toContain('#3 needs-input'), { timeout: 5_000 })
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

describe('StatusScreen as the hub', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

  it('moves between status columns with the arrows and lists their tasks with Enter', async () => {
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('my status:'), { timeout: 5_000 })
    await settle()
    stdin.write('\u001B[C')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('#3 Store users — plan'), { timeout: 5_000 })
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).not.toContain('#3 Store users — plan'), { timeout: 5_000 })
  })

  it('starts and stops the conveyor with c and shows its log', async () => {
    const runner = fakeRunner()
    const { lastFrame, stdin } = render(<StatusScreen load={async () => snapshot} refreshMs={60_000} runner={runner} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('[c] start conveyor'), { timeout: 5_000 })
    await settle()
    stdin.write('c')
    await vi.waitFor(() => expect(lastFrame()).toContain('claimed task 7: Login'), { timeout: 5_000 })
    expect(lastFrame()).toContain('running here')
    expect(lastFrame()).toContain('[c] stop conveyor')
    await settle()
    stdin.write('c')
    await vi.waitFor(() => expect(lastFrame()).toContain('The conveyor stopped.'), { timeout: 5_000 })
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
    await vi.waitFor(() => expect(lastFrame()).toContain('#3 needs-input'), { timeout: 5_000 })
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
    expect(result.stdout).toContain('My tasks')
    expect(result.stdout).toContain('none')
  })
})
