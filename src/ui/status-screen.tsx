import { TextInput } from '@inkjs/ui'
import { Box, Text, render, useApp, useInput } from 'ink'
import { useCallback, useEffect, useState } from 'react'
import type { RunnerEvent } from '../runner.js'
import type { StatusSnapshot } from '../status.js'
import { helpLines, statusLines, type Line } from './status-lines.js'

const COLORS: Record<NonNullable<Line['tone']>, string> = { muted: 'gray', warning: 'yellow', error: 'red', ok: 'green', title: 'cyan' }
const EVENT_COLORS: Record<RunnerEvent['level'], string> = { info: 'white', warning: 'yellow', error: 'red' }
const LOG_LINES = 8

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
  const [help, setHelp] = useState(false)
  const [ask, setAsk] = useState<'attach' | 'release'>()
  const [message, setMessage] = useState<{ text: string; error?: boolean } | undefined>(notice ? { text: notice } : undefined)
  const [confirmQuit, setConfirmQuit] = useState(false)
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
    (input) => {
      if (input !== 'q') setConfirmQuit(false)
      if (input === 'q') {
        if (runner?.running && !confirmQuit) {
          setConfirmQuit(true)
          setMessage({ text: 'The conveyor runs. Press q again to stop it and quit.', error: true })
          return
        }
        act({ kind: 'quit' })
      }
      if (input === 'r') refresh()
      if (input === 'h' || input === '?') setHelp((value) => !value)
      if (input === 's') act({ kind: 'settings' })
      if (input === 'n') act({ kind: 'new' })
      if (input === 'a') setAsk('attach')
      if (input === 'l') setAsk('release')
      if (input === 'c' && runner) {
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
  return (
    <Box flexDirection="column">
      {!help && !status && !error && <Text color="gray">Loading the board…</Text>}
      {(help ? helpLines() : status ? statusLines(status, runner?.running ? 'running here' : undefined) : []).map((line, index) => (
        <Text key={index} {...(line.tone ? { color: COLORS[line.tone] } : {})} bold={line.tone === 'title'}>
          {line.text || ' '}
        </Text>
      ))}
      {error && <Text color="red">Board error: {error}</Text>}
      {!help && events.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            Log
          </Text>
          {events.map((event, index) => (
            <Text key={index} color={EVENT_COLORS[event.level]}>
              {new Date(event.time).toLocaleTimeString()} {event.text.split('\n')[0]}
            </Text>
          ))}
        </Box>
      )}
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
      <Text color="gray">
        {runner ? `[c] ${runner.running ? 'stop' : 'start'} conveyor · ` : ''}[n] new · [a] attach · [l] release · [s] settings · [r] refresh · [h] help · [q] quit
        {updated ? ` · updated ${updated.toLocaleTimeString()}` : ''}
      </Text>
    </Box>
  )
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
  )
  await app.waitUntilExit()
  return next
}
