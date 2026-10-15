import { Select, TextInput } from '@inkjs/ui'
import { Box, Text, render, useApp, useInput } from 'ink'
import { useState } from 'react'
import { boardPath, type Board, type BoardTarget, type Target } from '../init.js'
import { clearOnShrink } from './terminal.js'

export type InitAnswers = { target: Target; board?: Board }

type Props = {
  askTarget: boolean
  detected: Partial<Board>
  check: (provider: Board['provider'], path: string) => Promise<BoardTarget>
  onDone: (answers: InitAnswers) => void
}

const TARGETS = [
  { label: 'Initialize a project in this directory', value: 'here' },
  { label: 'Initialize a project with settings at a path', value: 'path' },
  { label: 'Use existing settings', value: 'use' },
  { label: 'Cancel', value: 'cancel' },
]

const PROVIDERS = [
  { label: 'GitHub', value: 'github' },
  { label: 'GitLab', value: 'gitlab' },
]

export function InitPrompt({ askTarget, detected, check, onDone }: Props) {
  const { exit } = useApp()
  const [kind, setKind] = useState<Target['kind'] | undefined>(askTarget ? undefined : 'here')
  const [path, setPath] = useState<string>()
  const [provider, setProvider] = useState<Board['provider']>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const [group, setGroup] = useState<{ path: string; projects: string[] }>()

  const finish = (answers: InitAnswers) => {
    onDone(answers)
    exit()
  }

  useInput((_input, key) => {
    if (key.escape) exit()
  })

  if (!kind) {
    return (
      <Box flexDirection="column">
        <Text>No conveyor settings found.</Text>
        <Select options={TARGETS} onChange={(value) => (value === 'cancel' ? exit() : setKind(value as Target['kind']))} />
        <Text color="gray">Esc cancels</Text>
      </Box>
    )
  }

  if (kind !== 'here' && path === undefined) {
    return (
      <Box flexDirection="column">
        <Text>{kind === 'use' ? 'Path to the existing settings:' : 'Path for the new settings:'}</Text>
        <TextInput
          onSubmit={(value) => {
            if (!value.trim()) return
            if (kind === 'use') finish({ target: { kind, path: value.trim() } })
            else setPath(value.trim())
          }}
        />
      </Box>
    )
  }

  if (!provider) {
    return (
      <Box flexDirection="column">
        <Text>Board provider:</Text>
        <Select
          options={PROVIDERS.toSorted((option) => (option.value === detected.provider ? -1 : 0))}
          onChange={(value) => setProvider(value as Board['provider'])}
        />
      </Box>
    )
  }

  const target = (): Target => (kind === 'path' && path ? { kind, path } : { kind: 'here' })

  if (group) {
    return (
      <Box flexDirection="column">
        <Text>{group.path} is a GitLab group: the board shows the issues of all its projects.</Text>
        <Text>Project for new tasks:</Text>
        <Select
          options={group.projects.map((project) => ({ label: project, value: project }))}
          onChange={(project) => finish({ target: target(), board: { provider, project, group: group.path } })}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text>{provider === 'gitlab' ? 'Board project or group (path or URL):' : 'Board repository (owner/repo or URL):'}</Text>
      <TextInput
        defaultValue={detected.project}
        placeholder={provider === 'gitlab' ? 'group/project' : 'owner/repo'}
        isDisabled={checking}
        onSubmit={(input) => {
          const project = boardPath(input)
          if (!project) return
          setChecking(true)
          setError(undefined)
          void check(provider, input).then((found) => {
            setChecking(false)
            if (found.kind === 'missing') setError(found.error)
            else if (found.kind === 'project') finish({ target: target(), board: { provider, project } })
            else if (found.projects.length === 0) setError(`the group ${project} has no projects; create one for new tasks first`)
            else setGroup({ path: project, projects: found.projects })
          })
        }}
      />
      {checking && <Text color="gray">Checking the board…</Text>}
      {error && <Text color="red">{error}</Text>}
    </Box>
  )
}

export async function promptInit(props: Omit<Props, 'onDone'>): Promise<InitAnswers | undefined> {
  let answers: InitAnswers | undefined
  const restore = clearOnShrink()
  const app = render(<InitPrompt {...props} onDone={(result) => (answers = result)} />)
  await app.waitUntilExit()
  restore()
  return answers
}
