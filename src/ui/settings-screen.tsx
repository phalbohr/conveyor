import { Select, TextInput } from '@inkjs/ui'
import { Box, Text, render, useApp, useInput } from 'ink'
import { useState } from 'react'
import type { Field, SettingsDocument } from '../settings-editor.js'

const WINDOW = 18
const INHERIT = '(inherit)'

type Mode =
  | { kind: 'list' }
  | { kind: 'edit'; field: Field }
  | { kind: 'add-name' }
  | { kind: 'add-position'; name: string }
  | { kind: 'add-when'; name: string }

const stageOf = (field: Field | undefined) => (field?.group === 'Stages' ? field.key.split('.')[1] : undefined)
const inheritable = (field: Field) => field.group === 'Stages' || field.key.startsWith('defaults.') || field.key.startsWith('triage.')

export function SettingsScreen({ doc }: { doc: SettingsDocument }) {
  const { exit } = useApp()
  const [fields, setFields] = useState(() => doc.fields())
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [message, setMessage] = useState<{ text: string; error?: boolean }>()
  const [confirmQuit, setConfirmQuit] = useState(false)

  const reload = () => setFields(doc.fields())
  const attempt = (action: () => void) => {
    try {
      action()
      reload()
      setMessage(undefined)
    } catch (error) {
      setMessage({ text: (error as Error).message, error: true })
    }
  }

  useInput(
    (input, key) => {
      if (key.upArrow) setCursor((value) => Math.max(0, value - 1))
      if (key.downArrow) setCursor((value) => Math.min(fields.length - 1, value + 1))
      if (key.return && fields[cursor]) setMode({ kind: 'edit', field: fields[cursor] })
      if (input === 'a') setMode({ kind: 'add-name' })
      const stage = stageOf(fields[cursor])
      if (input === 'x' && stage) attempt(() => doc.removeStage(stage))
      if (input === '[' && stage) attempt(() => doc.moveStage(stage, -1))
      if (input === ']' && stage) attempt(() => doc.moveStage(stage, 1))
      if (input === 's') {
        const saved = doc.save()
        setMessage(saved.ok ? { text: 'Saved.' } : { text: saved.errors.join('\n'), error: true })
      }
      if (input === 'q' || key.escape) {
        if (doc.dirty() && !confirmQuit) {
          setConfirmQuit(true)
          setMessage({ text: 'Unsaved changes. Press q again to discard them, or s to save.', error: true })
          return
        }
        exit()
      }
      if (input !== 'q' && !key.escape) setConfirmQuit(false)
    },
    { isActive: mode.kind === 'list' },
  )

  useInput(
    (_input, key) => {
      if (key.escape) setMode({ kind: 'list' })
    },
    { isActive: mode.kind !== 'list' },
  )

  const done = () => {
    reload()
    setMode({ kind: 'list' })
  }

  if (mode.kind === 'edit') {
    const { field } = mode
    const options = [...(field.options ?? []), ...(inheritable(field) ? [INHERIT] : [])]
    return (
      <Box flexDirection="column">
        <Text color="cyan">{field.label}</Text>
        {field.kind === 'select' || field.kind === 'boolean' ? (
          <Select
            options={options.map((option) => ({ label: option, value: option }))}
            {...(field.value ? { defaultValue: field.value } : {})}
            onChange={(value) => {
              attempt(() => doc.set(field.key, value === INHERIT ? '' : value))
              done()
            }}
          />
        ) : (
          <TextInput
            defaultValue={field.value}
            onSubmit={(value) => {
              attempt(() => doc.set(field.key, value.trim()))
              done()
            }}
          />
        )}
        <Text color="gray">Enter: apply · Esc: cancel{inheritable(field) ? ' · empty value: inherit' : ''}</Text>
      </Box>
    )
  }

  if (mode.kind === 'add-name') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">New stage name (lowercase letters, digits, hyphens):</Text>
        <TextInput onSubmit={(value) => value.trim() && setMode({ kind: 'add-position', name: value.trim() })} />
      </Box>
    )
  }

  if (mode.kind === 'add-position') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Where does {mode.name} run?</Text>
        <Select
          options={[
            { label: 'before merge', value: 'before-merge' },
            { label: 'after merge', value: 'after-merge' },
          ]}
          onChange={(value) => {
            if (value === 'after-merge') return setMode({ kind: 'add-when', name: mode.name })
            attempt(() => doc.addStage(mode.name, 'before-merge'))
            done()
          }}
        />
      </Box>
    )
  }

  if (mode.kind === 'add-when') {
    return (
      <Box flexDirection="column">
        <Text color="cyan">When does {mode.name} run after merge?</Text>
        <Select
          options={['success', 'failure', 'always'].map((value) => ({ label: value, value }))}
          onChange={(value) => {
            attempt(() => doc.addStage(mode.name, 'after-merge', value as 'success' | 'failure' | 'always'))
            done()
          }}
        />
      </Box>
    )
  }

  const start = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), fields.length - WINDOW))
  const visible = fields.slice(start, start + WINDOW)
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        conveyor settings{doc.dirty() ? ' · unsaved changes' : ''}
      </Text>
      {visible.map((field, offset) => {
        const index = start + offset
        const header = index === 0 || fields[index - 1]?.group !== field.group
        return (
          <Box key={field.key} flexDirection="column">
            {header && <Text color="gray">{field.group}</Text>}
            <Text {...(index === cursor ? { color: 'cyan' } : {})}>
              {index === cursor ? '›' : ' '} {field.label.padEnd(34)} {field.value || <Text color="gray">{inheritable(field) ? INHERIT : '—'}</Text>}
            </Text>
          </Box>
        )
      })}
      {message && <Text color={message.error ? 'red' : 'green'}>{message.text}</Text>}
      <Text color="gray">↑↓ move · Enter edit · a add stage · x remove stage · [ ] move stage · s save · q quit</Text>
    </Box>
  )
}

export async function showSettings(doc: SettingsDocument) {
  const app = render(<SettingsScreen doc={doc} />)
  await app.waitUntilExit()
}
