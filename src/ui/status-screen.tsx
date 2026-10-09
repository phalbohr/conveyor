import { TextInput } from '@inkjs/ui'
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useState } from 'react'
import type { RunnerEvent } from '../runner.js'
import type { StatusSnapshot } from '../status.js'
import { CELL_WIDTH, STATUS_COLUMNS, helpLines, statusLines, usageLines, type Line, type StatusView } from './status-lines.js'

const COLORS: Record<NonNullable<Line['tone']>, string> = { muted: 'gray', warning: 'yellow', error: 'red', ok: 'green', title: 'cyan' }
const LOG_LINES = 30

export type RunnerControl = {
  readonly running: boolean
  readonly events: RunnerEvent[]
  subscribe(listener: () => void): () => void
  start(): Promise<{ ok: true } | { ok: false; error: string }>
  stop(): Promise<void>
}

export type HubAction =
  | { kind: 'quit' }
  | { kind: 'settings' }
  | { kind: 'new' }
  | { kind: 'attach'; id: string }
  | { kind: 'release'; id: string }

type Props = {
  load: () => Promise<StatusSnapshot>
  refreshMs: number
  runner?: RunnerControl
  notice?: string
  onAction?: (action: HubAction) => void
}

export function StatusScreen({ load, refreshMs, runner, notice, onAction }: Props) {
  const { exit } = useApp()
  const [status, setStatus] = useState<StatusSnapshot>()
  const [error, setError] = useState<string>()
  const [updated, setUpdated] = useState<Date>()
  const [panel, setPanel] = useState<'status' | 'help' | 'usage' | 'log'>('status')
  const [scroll, setScroll] = useState(0)
  const { columns, rows } = useWindowSize()
  const [ask, setAsk] = useState<'attach' | 'release'>()
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(notice ? { text: notice } : undefined)
  const [confirmQuit, setConfirmQuit] = useState(false)
  const [view, setView] = useState<StatusView>({ column: 0, open: false })
  const [, setTick] = useState(0)

  const refresh = useCallback(() => {
    load()
      .then((snapshot) => {
        setStatus(snapshot)
        setError(undefined)
        setUpdated(new Date())
      })
      .catch((cause: unknown) => setError((cause as Error).message))
  }, [load])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, refreshMs)
    return () => clearInterval(timer)
  }, [refresh, refreshMs])

  useEffect(() => runner?.subscribe(() => setTick((value) => value + 1)), [runner])

  const act = (action: HubAction) => {
    onAction?.(action)
    exit()
  }

  useInput(
    (input, key) => {
      if (input !== 'q') setConfirmQuit(false)
      if (key.escape && panel !== 'status') {
        setScroll(0)
        setPanel('status')
        return
      }
      if (input === 'q') {
        if (runner?.running && !confirmQuit) {
          setConfirmQuit(true)
          setMessage({ text: 'The conveyor runs. Press q again to stop it and quit.', error: true })
          return
        }
        act({ kind: 'quit' })
      }
      if (input === 'r') refresh()
      if (key.leftArrow || key.rightArrow) {
        setView((current) => ({ ...current, column: (current.column + (key.rightArrow ? 1 : -1) + STATUS_COLUMNS.length) % STATUS_COLUMNS.length }))
      }
      if (key.return) setView((current) => ({ ...current, open: !current.open }))
      const toggle = (next: typeof panel) => {
        setScroll(0)
        setPanel((current) => (current === next ? 'status' : next))
      }
      if (key.upArrow) setScroll((value) => Math.max(0, value - 1))
      if (key.downArrow) setScroll((value) => value + 1)
      if (input === 'h' || input === '?') toggle('help')
      if (input === 'u') toggle('usage')
      if (input === 'o') toggle('log')
      if (input === 'e') act({ kind: 'settings' })
      if (input === 'n') act({ kind: 'new' })
      if (input === 'a') setAsk('attach')
      if (input === 'l') setAsk('release')
      if (input === 's' && runner) {
        if (runner.running) {
          setMessage({ text: 'Stopping the conveyor…' })
          void runner.stop().then(() => {
            setMessage({ text: 'The conveyor stopped.' })
            refresh()
          })
        } else {
          setMessage({ text: 'Starting the conveyor…' })
          void runner.start().then((started) => {
            setMessage(started.ok ? { text: 'The conveyor runs.' } : { text: started.error, error: true })
            refresh()
          })
        }
      }
    },
    { isActive: ask === undefined },
  )

  useInput(
    (_input, key) => {
      if (key.escape) setAsk(undefined)
    },
    { isActive: ask !== undefined },
  )

  const events = runner?.events.slice(-LOG_LINES) ?? []
  const lines = panel === 'help' ? helpLines() : panel === 'usage' && status ? usageLines(status) : panel === 'log' ? logLines(events, status?.project) : status ? statusLines(status, runner?.running ? 'running here' : undefined, view) : []
  const footer = `${runner ? `[s] ${runner.running ? 'stop' : 'start'} conveyor · ` : ''}[←→] status column · [Enter] its tasks · [↑↓] scroll · [u] usage · [o] log · [n] new · [a] attach · [l] release · [e] settings · [r] refresh · [h] help · [q] quit${updated ? ` · updated ${updated.toLocaleTimeString()}` : ''}`
  const room = Math.max(3, rows - 1 - heightOf(footer, columns) - heightOf(message?.text ?? '', columns) - (ask ? 4 : 0) - (error ? 1 : 0) - 1)
  const page = viewport(lines, scroll, room, columns)
  return (
    <Box flexDirection="column">
      {panel === 'status' && !status && !error && <Text color="gray">Loading the board…</Text>}
      {page.lines.map((line, index) =>
        line.cells ? (
          <Box key={index}>
            <Box flexShrink={0} width={CELL_WIDTH}>
              <Text>{line.cells[0]}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">{line.cells[1]}</Text>
            </Box>
          </Box>
        ) : (
        <Text key={index} {...(line.tone ? { color: COLORS[line.tone] } : {})} bold={line.tone === 'title'}>
          {line.segments
            ? line.segments.map((segment, part) => (
                <Text key={part} inverse={segment.selected ?? false}>
                  {segment.text}
                </Text>
              ))
            : line.text || ' '}
        </Text>
        ),
      )}
      {page.more && <Text color="gray">{`\n${page.more}`}</Text>}
      {error && <Text color="red">Board error: {error}</Text>}
      {ask && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">{ask === 'attach' ? 'Answer the questions of the task with issue number:' : 'Release the claim of the task with issue number:'}</Text>
          <TextInput
            placeholder="#<issue number>"
            onSubmit={(value) => {
              const id = value.trim().replace(/^#/, '')
              if (/^\d+$/.test(id)) act({ kind: ask, id })
              else setMessage({ text: 'Enter the issue number from the board, for example #51.', error: true })
            }}
          />
        </Box>
      )}
      {message && <Text color={message.error ? 'red' : 'green'}>{message.text}</Text>}
      <Text> </Text>
      <Text color="gray">{footer}</Text>
    </Box>
  )
}

function heightOf(text: string, columns: number) {
  if (!text) return 0
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, columns))), 0)
}

function lineHeight(line: Line, columns: number) {
  return line.cells ? heightOf(line.cells[1] || ' ', columns - CELL_WIDTH) : heightOf(line.text || ' ', columns)
}

function viewport(lines: Line[], scroll: number, room: number, columns: number): { lines: Line[]; more?: string } {
  const total = lines.reduce((sum, line) => sum + lineHeight(line, columns), 0)
  if (total <= room) return { lines }
  let last = lines.length
  let tail = 0
  while (last > 0 && tail + lineHeight(lines[last - 1] as Line, columns) <= room - 2) tail += lineHeight(lines[--last] as Line, columns)
  const start = Math.min(scroll, last)
  const shown: Line[] = []
  let used = 0
  for (const line of lines.slice(start)) {
    const height = lineHeight(line, columns)
    if (used + height > room - 2) break
    shown.push(line)
    used += height
  }
  return { lines: shown, more: `lines ${start + 1}–${start + shown.length} of ${lines.length} · ↑↓ scroll` }
}

function logLines(events: RunnerEvent[], project?: string): Line[] {
  const file = project ? `~/.conveyor/logs/${project.replaceAll('/', '-')}.log` : '~/.conveyor/logs/'
  return [
    { text: `Log · last ${LOG_LINES} events · full log ${file} · [o] or Esc back`, tone: 'title' },
    ...(events.length === 0 ? [{ text: '  no events yet: start the conveyor with s', tone: 'muted' as const }] : []),
    ...events.map((event): Line => ({
      text: `${new Date(event.time).toLocaleTimeString()} ${event.text.split('\n')[0]}`,
      ...(event.level === 'error' ? { tone: 'error' as const } : event.level === 'warning' ? { tone: 'warning' as const } : {}),
    })),
  ]
}

export async function showStatus(
  load: () => Promise<StatusSnapshot>,
  options: { runner?: RunnerControl; notice?: string; refreshMs?: number } = {},
): Promise<HubAction> {
  let next: HubAction = { kind: 'quit' }
  const app = render(
    <StatusScreen
      load={load}
      refreshMs={options.refreshMs ?? 30_000}
      {...(options.runner ? { runner: options.runner } : {})}
      {...(options.notice ? { notice: options.notice } : {})}
      onAction={(action) => (next = action)}
    />,
    { alternateScreen: true },
  )
  await app.waitUntilExit()
  return next
}
