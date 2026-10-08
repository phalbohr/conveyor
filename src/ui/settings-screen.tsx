import { Select, TextInput } from '@inkjs/ui'
import { Box, Text, render, useApp, useInput } from 'ink'
import { useState } from 'react'
import type { Catalog } from '../models.js'
import type { Field, SettingsDocument } from '../settings-editor.js'

const WINDOW = 18
const INHERIT = '(inherit)'
const OTHER = 'other…'

type Mode =
  | { kind: 'list' }
  | { kind: 'edit'; field: Field }
  | { kind: 'edit-text'; field: Field }
  | { kind: 'add-name' }
  | { kind: 'add-position'; name: string }
  | { kind: 'add-when'; name: string }

const stageOf = (field: Field | undefined) => (field?.group === 'Stages' ? field.key.split('.')[1] : undefined)
const inheritable = (field: Field) => field.group === 'Stages' || field.key.startsWith('defaults.') || field.key.startsWith('triage.')
const FROM_DEFAULTS = ['harness', 'model', 'effort']
const shown = (field: Field) => {
  if (field.value) return field.value
  if (!inheritable(field)) return '—'
  if (!field.inherited) return INHERIT
  return FROM_DEFAULTS.includes(field.key.split('.').at(-1) ?? '') ? `(defaults: ${field.inherited})` : `(default: ${field.inherited})`
}

type Props = { doc: SettingsDocument; refreshModels?: () => Promise<Record<string, Catalog>> }

export function SettingsScreen({ doc, refreshModels }: Props) {
  const { exit } = useApp()
  const [fields, setFields] = useState(() => doc.fields())
  const [problems, setProblems] = useState(() => doc.problems())
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [message, setMessage] = useState<{ text: string; error?: boolean }>()
  const [confirmQuit, setConfirmQuit] = useState(false)

  const reload = () => {
    setFields(doc.fields())
    setProblems(doc.problems())
  }
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
      const current = fields[cursor]
      if ((key.leftArrow || key.rightArrow) && current?.options) {
        const options = [...current.options, ...(inheritable(current) ? [INHERIT] : [])]
        const index = options.indexOf(current.value || INHERIT)
        const next = options[(index + (key.rightArrow ? 1 : -1) + options.length) % options.length] ?? INHERIT
        attempt(() => doc.set(current.key, next === INHERIT ? '' : next))
      }
      if (input === 'a') setMode({ kind: 'add-name' })
      if (input === 'm' && refreshModels) {
        setMessage({ text: 'Refreshing model lists…' })
        refreshModels()
          .then((catalogs) => {
            doc.setCatalogs(catalogs)
            reload()
            setMessage({ text: 'Model lists updated.' })
          })
          .catch((error: unknown) => setMessage({ text: (error as Error).message, error: true }))
      }
      const stage = stageOf(fields[cursor])
      if (input === 'x' && stage) attempt(() => doc.removeStage(stage))
      if (input === '[' && stage) attempt(() => doc.moveStage(stage, -1))
      if (input === ']' && stage) attempt(() => doc.moveStage(stage, 1))
      if (input === 's') {
        const saved = doc.save()
        setMessage(
          saved.ok
            ? { text: ['Saved.', ...(saved.created ?? []).map((file) => `Created ${file}: describe the stage there.`)].join('\n') }
            : { text: saved.errors.join('\n'), error: true },
        )
        reload()
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

  if (mode.kind === 'edit-text') {
    const { field } = mode
    return (
      <Box flexDirection="column">
        <Text color="cyan">{field.key.endsWith('.model') ? 'Model name' : field.label}</Text>
        <TextInput
          defaultValue={field.value}
          onSubmit={(value) => {
            attempt(() => doc.set(field.key, value.trim()))
            done()
          }}
        />
        <Text color="gray">Enter: apply · Esc: cancel</Text>
      </Box>
    )
  }

  if (mode.kind === 'edit') {
    const { field } = mode
    const options = [...(field.options ?? []), ...(inheritable(field) ? [INHERIT] : []), ...(field.other ? [OTHER] : [])]
    return (
      <Box flexDirection="column">
        <Text color="cyan">{field.label}</Text>
        {field.kind === 'select' || field.kind === 'boolean' ? (
          <Select
            options={options.map((option) => ({ label: option, value: option }))}
              {...(field.value && !field.other ? { defaultValue: field.value } : {})}
            onChange={(value) => {
              if (value === OTHER) return setMode({ kind: 'edit-text', field })
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
  const width = Math.max(16, ...fields.map((field) => shown(field).length + 1))
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
              {index === cursor ? '›' : ' '} {field.label.padEnd(30)} {shown(field).padEnd(width)}
              <Text color="gray">{field.help}</Text>
            </Text>
          </Box>
        )
      })}
      {problems.length > 0 && <Text color="yellow">{['Not valid yet, cannot be saved:', ...problems].join('\n')}</Text>}
      {message && <Text color={message.error ? 'red' : 'green'}>{message.text}</Text>}
      <Text color="gray">↑↓ move · ←→ change option · Enter edit · m refresh models · a add stage · x remove stage · [ ] move stage · s save · q quit</Text>
    </Box>
  )
}

export async function showSettings(doc: SettingsDocument, refreshModels?: () => Promise<Record<string, Catalog>>) {
  const app = render(<SettingsScreen doc={doc} {...(refreshModels ? { refreshModels } : {})} />)
  await app.waitUntilExit()
}
