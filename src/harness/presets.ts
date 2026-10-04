import type { CommandDefinition } from './command.js'

export const PRESETS: Record<string, CommandDefinition> = {
  opencode: {
    command: 'opencode',
    args: ['run', '--auto', '-m', '{model}', '--dir', '{workspace}', '{prompt}'],
    env: {},
  },
  pi: {
    command: 'pi',
    args: ['--mode', 'json', '--model', '{model}', '--thinking', '{effort}', '--', '{prompt}'],
    env: {},
  },
  openhands: {
    command: 'openhands',
    args: ['--headless', '--override-with-envs', '--json', '-t', '{prompt}'],
    env: { LLM_MODEL: '{model}', OPENHANDS_WORK_DIR: '{workspace}' },
  },
  'agent-zero': {
    command: 'a0',
    args: ['headless', '-p', '{prompt}', '--output', 'jsonl', '--workspace', '{workspace}'],
    env: {},
  },
}
