import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import type { StatusSnapshot } from '../src/status.js'
import { statusLines } from '../src/ui/status-lines.js'
import { StatusScreen } from '../src/ui/status-screen.js'
import { runCli } from './helpers.js'

const snapshot: StatusSnapshot = {
  settings: '/repo/.conveyor',
  project: 'acme/app',
  provider: 'github',
  me: 'me',
  runner: { running: false },
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
  it('shows the runner, limits, subscription windows, my tasks, and the team queue', () => {
    const lines = statusLines(snapshot)
    const text = lines.map((line) => line.text).join('\n')
    expect(text).toContain('acme/app (github) · @me · stopped')
    expect(text).toContain('waiting for me 1/1')
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

  it('shows a board error', async () => {
    const { lastFrame } = render(<StatusScreen load={async () => Promise.reject(new Error('gh: not logged in'))} refreshMs={60_000} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('Board error: gh: not logged in'), { timeout: 5_000 })
  })
})

describe('conveyor without arguments', () => {
  it('prints the status as JSON', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const board = new FakeBoard('me')
    const task = await board.createTask('Mine', 'p', 'in-progress')
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
