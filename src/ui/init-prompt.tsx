import { Select, TextInput } from '@inkjs/ui'
import { Box, Text, render, useApp } from 'ink'
import { useState } from 'react'
import type { Board, Target } from '../init.js'

export type InitAnswers = { target: Target; board?: Board }

type Props = {
  askTarget: boolean
  detected: Partial<Board>
  onDone: (answers: InitAnswers) => void
}

const TARGETS = [
  { label: 'Initialize a project in this directory', value: 'here' },
  { label: 'Initialize a project with settings at a path', value: 'path' },
  { label: 'Use existing settings', value: 'use' },
]

const PROVIDERS = [
  { label: 'GitHub', value: 'github' },
  { label: 'GitLab', value: 'gitlab' },
]

export function InitPrompt({ askTarget, detected, onDone }: Props) {
  const { exit } = useApp()
  const [kind, setKind] = useState<Target['kind'] | undefined>(askTarget ? undefined : 'here')
  const [path, setPath] = useState<string>()
  const [provider, setProvider] = useState<Board['provider']>()

  const finish = (answers: InitAnswers) => {
    onDone(answers)
    exit()
  }

  if (!kind) {
    return (
      <Box flexDirection="column">
        <Text>No conveyor settings found.</Text>
        <Select options={TARGETS} onChange={(value) => setKind(value as Target['kind'])} />
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

  return (
    <Box flexDirection="column">
      <Text>Board project (owner/repo):</Text>
      <TextInput
        defaultValue={detected.project}
        placeholder="owner/repo"
        onSubmit={(project) => {
          if (!project.trim()) return
          const target: Target = kind === 'path' && path ? { kind, path } : { kind: 'here' }
          finish({ target, board: { provider, project: project.trim() } })
        }}
      />
    </Box>
  )
}

export async function promptInit(props: Omit<Props, 'onDone'>): Promise<InitAnswers | undefined> {
  let answers: InitAnswers | undefined
  const app = render(<InitPrompt {...props} onDone={(result) => (answers = result)} />)
  await app.waitUntilExit()
  return answers
}
