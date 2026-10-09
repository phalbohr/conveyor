import { TextInput } from '@inkjs/ui'
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useState } from 'react'
import type { RunnerEvent } from '../runner.js'
import type { StatusSnapshot } from '../status.js'
import { BACKLOG, CELL_WIDTH, STATUS_COLUMNS, boardLines, columnTasks, helpLines, statusLines, usageLines, type Line, type StatusView } from './status-lines.js'
import { taskLines, type Target, type TaskControl, type TaskDetail } from './task-lines.js'

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
  | { kind: 'harness'; id: string }

type Props = {
  load: () => Promise<StatusSnapshot>
  refreshMs: number
  runner?: RunnerControl
  control?: TaskControl
  notice?: string
  onAction?: (action: HubAction) => void
}

type Panel = 'status' | 'help' | 'usage' | 'log' | 'task' | 'board'
type Input = { kind: 'attach' | 'release' } | { kind: 'comment'; id: string; target: Target }
type Opened = { id: string; target: Target; detail?: TaskDetail }

export function StatusScreen({ load, refreshMs, runner, control, notice, onAction }: Props) {
  const { exit } = useApp()
  const [status, setStatus] = useState<StatusSnapshot>()
  const [error, setError] = useState<string>()
  const [updated, setUpdated] = useState<Date>()
  const [panel, setPanel] = useState<Panel>('status')
  const [scroll, setScroll] = useState(0)
  const { columns, rows } = useWindowSize()
  const [input, setInput] = useState<Input>()
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(notice ? { text: notice } : undefined)
  const [confirmQuit, setConfirmQuit] = useState(false)
  const [view, setView] = useState<StatusView>({ column: 0, open: false, focus: 'columns', task: 0 })
  const [opened, setOpened] = useState<Opened>()
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
  const fail = (cause: unknown) => setMessage({ text: (cause as Error).message, error: true })
  const tasks = status ? columnTasks(status, view.column) : []
  const selected = view.focus === 'tasks' ? tasks[view.task] : undefined
  const current = panel === 'task' ? opened : selected ? { id: selected.id, target: 'issue' as Target } : undefined
  const url = panel === 'task' && opened?.detail ? (opened.target === 'pull' && opened.detail.pull ? opened.detail.pull.url : opened.detail.task.url) : selected?.url

  const openTask = (id: string, target: Target = 'issue') => {
    if (!control) return
    setOpened({ id, target })
    setPanel('task')
    setScroll(0)
    control
      .detail(id)
      .then((detail) => setOpened({ id, target, detail }))
      .catch(fail)
  }
  const moveColumn = (delta: number) =>
    setView((now) => {
      const column = (now.column + delta + STATUS_COLUMNS.length) % STATUS_COLUMNS.length
      return { ...now, column, task: 0, focus: now.focus === 'tasks' && status && columnTasks(status, column).length > 0 ? 'tasks' : 'columns' }
    })

  useInput(
    (key, special) => {
      if (key !== 'q') setConfirmQuit(false)
      const toggle = (next: Panel) => {
        setScroll(0)
        setPanel((now) => (now === next ? 'status' : next))
      }
      if (special.escape) {
        if (panel === 'task') {
          setPanel('status')
          setScroll(0)
        } else if (panel !== 'status') toggle(panel)
        else setView((now) => ({ ...now, focus: 'columns' }))
        return
      }
      if (key === 'q') {
        if (runner?.running && !confirmQuit) {
          setConfirmQuit(true)
          setMessage({ text: 'The conveyor runs. Press q again to stop it and quit.', error: true })
          return
        }
        act({ kind: 'quit' })
        return
      }
      if (key === '?' || (key === 'h' && panel === 'help')) toggle('help')
      if (key === 'u') toggle('usage')
      if (key === 'o') toggle('log')
      if (key === 'k') toggle('board')
      if (key === 'r') {
        refresh()
        if (panel === 'task' && opened) openTask(opened.id, opened.target)
      }
      if (current && control) {
        if (key === 'c') setInput({ kind: 'comment', id: current.id, target: current.target })
        if (key === 'b' && url) void control.open(url).catch(fail)
        if (key === 'h') act({ kind: 'harness', id: current.id })
      }
      if (panel === 'task') {
        if (special.upArrow) setScroll((value) => Math.max(0, value - 1))
        if (special.downArrow) setScroll((value) => value + 1)
        if (key === 'p' && opened?.detail?.pull) {
          setOpened({ ...opened, target: opened.target === 'pull' ? 'issue' : 'pull' })
          setScroll(0)
        }
        return
      }
      if (panel === 'board' && special.return && control) {
        setMessage({ text: 'Adding the missing labels and fields…' })
        void control
          .updateBoard()
          .then((text) => {
            setMessage({ text })
            refresh()
          })
          .catch(fail)
        return
      }
      if (panel !== 'status') {
        if (special.upArrow) setScroll((value) => Math.max(0, value - 1))
        if (special.downArrow) setScroll((value) => value + 1)
        return
      }
      if (special.leftArrow || special.rightArrow) moveColumn(special.rightArrow ? 1 : -1)
      if (view.focus === 'tasks') {
        if (special.upArrow) setView((now) => (now.task === 0 ? { ...now, focus: 'columns' } : { ...now, task: now.task - 1 }))
        if (special.downArrow) setView((now) => ({ ...now, task: Math.min(tasks.length - 1, now.task + 1) }))
        if (special.return && selected) openTask(selected.id)
        if (key === 'i' && selected && control) {
          if (view.column !== BACKLOG) setMessage({ text: 'i sets or removes form::idea on backlog tasks only.', error: true })
          else
            void control
              .toggleIdea(selected.id)
              .then((text) => {
                setMessage({ text })
                refresh()
              })
              .catch(fail)
        }
        return
      }
      if (special.return) setView((now) => ({ ...now, open: !now.open }))
      if (special.downArrow && tasks.length > 0) setView((now) => ({ ...now, open: true, focus: 'tasks', task: 0 }))
      if (key === 'h') toggle('help')
      if (key === 'b' && control) void control.openBoard().catch(fail)
      if (key === 'e') act({ kind: 'settings' })
      if (key === 'n') act({ kind: 'new' })
      if (key === 'a') setInput({ kind: 'attach' })
      if (key === 'l') setInput({ kind: 'release' })
      if (key === 's' && runner) {
        if (runner.running) {
          setMessage({ text: 'Stopping the conveyor…' })
          void runner.stop().then(() => {
            setMessage({ text: 'The conveyor stopped.' })
            refresh()
          })
        } else {
          setMessage({ text: 'Starting the conveyor…' })
          void runner.start().then((started) => {
            setMessage(started.ok ? { text: 'The conveyor runs. [o] log' } : { text: started.error, error: true })
            refresh()
          })
        }
      }
    },
    { isActive: input === undefined },
  )

  useInput(
    (_key, special) => {
      if (special.escape) setInput(undefined)
    },
    { isActive: input !== undefined },
  )

  const events = runner?.events.slice(-LOG_LINES) ?? []
  const lines =
    panel === 'help'
      ? helpLines()
      : panel === 'usage' && status
        ? usageLines(status)
        : panel === 'log'
          ? logLines(events, status?.project)
          : panel === 'board' && status
            ? boardLines(status)
          : panel === 'task'
            ? opened?.detail
              ? taskLines(opened.detail, opened.target)
              : [{ text: `Loading task #${opened?.id ?? ''}…`, tone: 'muted' as const }]
            : status
              ? statusLines(status, runner?.running ? 'running here' : undefined, view)
              : []
  const footer = keyBar(panel, view, runner, opened, updated)
  const room = Math.max(3, rows - 1 - heightOf(footer, columns) - heightOf(message?.text ?? '', columns) - (input ? 4 : 0) - (error ? 1 : 0) - 1)
  const focusLine = panel === 'status' && view.focus === 'tasks' ? lines.findIndex((line) => line.text.startsWith('›')) : -1
  const page = viewport(lines, focusLine >= 0 ? Math.max(0, focusLine - room + 4) : scroll, room, columns)
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
      {input && (input.kind === 'attach' || input.kind === 'release') && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">{input.kind === 'attach' ? 'Answer the questions of the task with issue number:' : 'Release the claim of the task with issue number:'}</Text>
          <TextInput
            placeholder="#<issue number>"
            onSubmit={(value) => {
              const id = value.trim().replace(/^#/, '')
              if (/^\d+$/.test(id)) act({ kind: input.kind, id })
              else setMessage({ text: 'Enter the issue number from the board, for example #51.', error: true })
            }}
          />
        </Box>
      )}
      {input?.kind === 'comment' && control && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">{`Comment on #${input.id}${input.target === 'pull' ? ' (pull request)' : ''} · Enter posts · Esc cancels`}</Text>
          <TextInput
            placeholder="your comment, for example /approve or an answer"
            onSubmit={(value) => {
              const body = value.trim()
              setInput(undefined)
              if (!body) return
              control
                .comment(input.id, input.target, body)
                .then(() => {
                  setMessage({ text: `Comment posted on #${input.id}.` })
                  refresh()
                  if (panel === 'task') openTask(input.id, input.target)
                })
                .catch(fail)
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

function keyBar(panel: Panel, view: StatusView, runner: RunnerControl | undefined, opened: Opened | undefined, updated: Date | undefined) {
  const time = updated ? ` · updated ${updated.toLocaleTimeString()}` : ''
  if (panel === 'task') {
    return `[↑↓] scroll · [c] comment · [b] browser · [h] harness${opened?.detail?.pull ? ` · [p] ${opened.target === 'pull' ? 'issue' : 'pull request'}` : ''} · [r] reload · [Esc] back`
  }
  if (panel === 'board') return `[Enter] add what is missing · [↑↓] scroll · [Esc] back · [q] quit`
  if (panel !== 'status') return `[↑↓] scroll · [Esc] back · [q] quit`
  if (view.focus === 'tasks') {
    return `[↑↓] select · [←→] column · [Enter] open · [c] comment · [b] browser · [h] harness${view.column === BACKLOG ? ' · [i] form::idea on/off' : ''} · [Esc] columns · [?] help · [q] quit${time}`
  }
  return `${runner ? `[s] ${runner.running ? 'stop' : 'start'} conveyor · ` : ''}[←→] column · [Enter] list · [↓] tasks · [b] board in browser · [k] board check · [u] usage · [o] log · [n] new · [a] attach · [l] release · [e] settings · [r] refresh · [h] help · [q] quit${time}`
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
  options: { runner?: RunnerControl; control?: TaskControl; notice?: string; refreshMs?: number } = {},
): Promise<HubAction> {
  let next: HubAction = { kind: 'quit' }
  const app = render(
    <StatusScreen
      load={load}
      refreshMs={options.refreshMs ?? 30_000}
      {...(options.runner ? { runner: options.runner } : {})}
      {...(options.control ? { control: options.control } : {})}
      {...(options.notice ? { notice: options.notice } : {})}
      onAction={(action) => (next = action)}
    />,
    { alternateScreen: true },
  )
  await app.waitUntilExit()
  return next
}
