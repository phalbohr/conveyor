import { Box, Text, render, useApp, useInput } from 'ink'
import { useCallback, useEffect, useState } from 'react'
import type { StatusSnapshot } from '../status.js'
import { statusLines, type Line } from './status-lines.js'

const COLORS: Record<NonNullable<Line['tone']>, string> = { muted: 'gray', warning: 'yellow', error: 'red', ok: 'green', title: 'cyan' }

type Props = { load: () => Promise<StatusSnapshot>; refreshMs: number; onSettings?: () => void }

export function StatusScreen({ load, refreshMs, onSettings }: Props) {
  const { exit } = useApp()
  const [status, setStatus] = useState<StatusSnapshot>()
  const [error, setError] = useState<string>()
  const [updated, setUpdated] = useState<Date>()

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

  useInput((input) => {
    if (input === 'q') exit()
    if (input === 'r') refresh()
    if (input === 's' && onSettings) {
      onSettings()
      exit()
    }
  })

  return (
    <Box flexDirection="column">
      {!status && !error && <Text color="gray">Loading the board…</Text>}
      {status &&
        statusLines(status).map((line, index) => (
          <Text key={index} {...(line.tone ? { color: COLORS[line.tone] } : {})} bold={line.tone === 'title'}>
            {line.text || ' '}
          </Text>
        ))}
      {error && <Text color="red">Board error: {error}</Text>}
      <Text color="gray">
        [r] refresh · [s] settings · [q] quit{updated ? ` · updated ${updated.toLocaleTimeString()}` : ''}
      </Text>
    </Box>
  )
}

export async function showStatus(load: () => Promise<StatusSnapshot>, refreshMs = 30_000): Promise<'settings' | 'quit'> {
  let next: 'settings' | 'quit' = 'quit'
  const app = render(<StatusScreen load={load} refreshMs={refreshMs} onSettings={() => (next = 'settings')} />)
  await app.waitUntilExit()
  return next
}
