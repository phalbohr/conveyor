import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const BOARD = 'board: {provider: github, project: owner/repo}\n'

function settings(config?: string, local?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'conveyor-config-'))
  if (config !== undefined) writeFileSync(join(dir, 'config.yaml'), config)
  if (local !== undefined) writeFileSync(join(dir, 'local.yaml'), local)
  return dir
}

function load(config?: string, local?: string) {
  return loadConfig(settings(config, local))
}

function config(text: string, local?: string) {
  const result = load(text, local)
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result.config
}

function errors(text?: string, local?: string) {
  const result = load(text, local)
  if (result.ok) throw new Error('expected errors')
  return result.errors
}

describe('loadConfig', () => {
  it('applies defaults to a minimal configuration', () => {
    const c = config(BOARD)
    expect(c.board).toEqual({ provider: 'github', project: 'owner/repo' })
    expect(c.artifacts).toEqual({
      idea: { store: 'board', write: 'replace' },
      story: { store: 'board', write: 'replace' },
      plan: { store: 'board', write: 'replace' },
    })
    expect(c.pickup_from).toBe('plan')
    expect(c.transitions).toEqual({ idea_to_story: 'interactive', story_to_plan: 'interactive', merge: 'human' })
    expect(c.triage).toEqual({ harness: 'claude', model: 'sonnet', effort: 'medium' })
    expect(c.stages.map((s) => s.name)).toEqual(['story', 'plan', 'merge'])
    expect(c.timeouts).toEqual({
      stage: 60 * 60_000,
      stall: 5 * 60_000,
      heartbeat: 30 * 60_000,
      waiting: { days: 4, working: false },
    })
    expect(c.retry).toEqual({ max_backoff: 5 * 60_000, max_attempts: 5 })
    expect(c.hooks).toEqual({ timeout: 60_000 })
    expect(c.limits).toEqual({
      running: 3,
      awaiting_me: 5,
      awaiting_review: 2,
      daily_tokens: 0,
      subscription: { five_hour_reserve: 0, seven_day_reserve: 0, probe: false },
    })
    expect(c.poll_interval).toBe(5 * 60_000)
    expect(c.pickup).toEqual({ assignee: 'me', include_unassigned: true })
    expect(c.workspace).toEqual({ root: '~/.conveyor/workspaces/{project}' })
  })

  it('takes the documentation language from the team and the chat language from the member', () => {
    expect(config(BOARD).language).toEqual({ docs: 'English' })
    expect(config(`${BOARD}language: {docs: German}\n`, 'language: {chat: Russian}\n').language).toEqual({ docs: 'German', chat: 'Russian' })
  })

  it('keeps the documentation language out of the personal settings', () => {
    expect(errors(BOARD, 'language: {docs: Russian}\n')).toContainEqual(expect.stringContaining('language'))
  })

  it('fills missing stage values from defaults per field', () => {
    const c = config(`${BOARD}
defaults: {harness: claude, model: sonnet, effort: medium}
triage: {model: opus}
stages:
  plan: {harness: codex, model: gpt-5-codex}
  implement: {}
`)
    expect(c.triage).toEqual({ harness: 'claude', model: 'opus', effort: 'medium' })
    expect(c.stages).toContainEqual({ name: 'plan', harness: 'codex', model: 'gpt-5-codex', effort: 'medium', sandbox: 'workspace-write', network: true })
    expect(c.stages).toContainEqual({ name: 'implement', harness: 'claude', model: 'sonnet', effort: 'medium' })
  })

  it('keeps stage order and adds missing reserved stages', () => {
    const c = config(`${BOARD}
stages:
  implement: {}
  review: {}
  review-2: {}
`)
    expect(c.stages.map((s) => s.name)).toEqual(['story', 'plan', 'implement', 'review', 'review-2', 'merge'])
  })

  it('gives post-merge stages a when condition with default success', () => {
    const c = config(`${BOARD}
stages:
  implement: {}
  merge: {}
  verify: {}
  fix-ci: {when: failure}
`)
    expect(c.stages.find((s) => s.name === 'implement')?.when).toBeUndefined()
    expect(c.stages.find((s) => s.name === 'verify')?.when).toBe('success')
    expect(c.stages.find((s) => s.name === 'fix-ci')?.when).toBe('failure')
  })

  it('rejects a custom stage before plan', () => {
    expect(errors(`${BOARD}
stages:
  research: {}
  plan: {}
`)).toContainEqual(expect.stringContaining('research'))
  })

  it('rejects reserved stages in the wrong order', () => {
    expect(errors(`${BOARD}
stages:
  merge: {}
  plan: {}
`)).toContainEqual(expect.stringContaining('order'))
  })

  it('rejects when on a pre-merge stage', () => {
    expect(errors(`${BOARD}
stages:
  implement: {when: failure}
  merge: {}
`)).toContainEqual(expect.stringContaining('implement'))
  })

  it('rejects an invalid stage name', () => {
    expect(errors(`${BOARD}
stages:
  Bad_Name: {}
`)).toContainEqual(expect.stringContaining('Bad_Name'))
  })

  it('accepts sandbox and network options for codex stages', () => {
    const c = config(`${BOARD}
stages:
  implement: {harness: codex, sandbox: full-access, network: false}
`)
    expect(c.stages.find((s) => s.name === 'implement')).toMatchObject({ sandbox: 'full-access', network: false })
  })

  it('rejects sandbox and network options on non-codex stages', () => {
    expect(errors(`${BOARD}
stages:
  implement: {harness: claude, network: true}
`)).toContainEqual(expect.stringContaining('implement'))
  })

  it('accepts harnesses defined in the configuration and merges personal overrides', () => {
    const c = config(
      `${BOARD}
harnesses:
  opencode:
    command: opencode
    args: [run, --model, "{model}", "{prompt}"]
    env: {OPENAI_BASE_URL: "http://team-proxy:4000", LOG: "1"}
stages:
  implement: {harness: opencode, model: litellm/qwen3-coder}
`,
      'harnesses:\n  opencode:\n    env: {OPENAI_BASE_URL: "http://localhost:4000"}\n',
    )
    expect(c.harnesses.opencode).toEqual({
      command: 'opencode',
      args: ['run', '--model', '{model}', '{prompt}'],
      env: { OPENAI_BASE_URL: 'http://localhost:4000', LOG: '1' },
      models: { args: ['models'] },
    })
    expect(c.stages.find((stage) => stage.name === 'implement')).toMatchObject({ harness: 'opencode', model: 'litellm/qwen3-coder' })
  })

  it('provides presets for opencode, pi, openhands, and agent-zero', () => {
    const c = config(`${BOARD}
harnesses:
  openhands:
    env: {LLM_BASE_URL: "http://litellm:4000"}
stages:
  implement: {harness: pi, model: litellm/qwen3-coder}
  review: {harness: openhands, model: litellm_proxy/qwen3-coder}
`)
    expect(Object.keys(c.harnesses).sort()).toEqual(['agent-zero', 'opencode', 'openhands', 'pi'])
    expect(c.harnesses.pi?.command).toBe('pi')
    expect(c.harnesses.openhands?.env).toEqual({ LLM_MODEL: '{model}', OPENHANDS_WORK_DIR: '{workspace}', LLM_BASE_URL: 'http://litellm:4000' })
  })

  it('rejects a personal harness without a command', () => {
    expect(errors(BOARD, 'harnesses:\n  mine:\n    args: ["{prompt}"]\n')).toContainEqual(expect.stringContaining('harnesses.mine'))
  })

  it('rejects an unknown harness', () => {
    expect(errors(`${BOARD}
stages:
  implement: {harness: gemini}
`)).toContainEqual(expect.stringContaining('harness'))
  })

  it('requires a path for repo and path storage', () => {
    expect(errors(`${BOARD}
artifacts:
  plan: {store: repo}
`)).toContainEqual(expect.stringContaining('artifacts.plan'))
  })

  it('accepts a private artifact override when the team allows it', () => {
    const c = config(
      `${BOARD}
artifacts:
  plan: {store: repo, path: docs/plans, allow_private: true}
`,
      'artifacts:\n  plan: {store: path, path: "~/Plans/{project}"}\n',
    )
    expect(c.artifacts.plan).toEqual({ store: 'path', path: '~/Plans/{project}', write: 'replace' })
  })

  it('rejects a private artifact override when the team does not allow it', () => {
    expect(
      errors(`${BOARD}
artifacts:
  plan: {store: repo, path: docs/plans}
`, 'artifacts:\n  plan: {store: path, path: ~/Plans}\n'),
    ).toContainEqual(expect.stringContaining('allow_private'))
  })

  it('parses waiting time in working days', () => {
    expect(config(`${BOARD}timeouts: {waiting: 2wd}\n`).timeouts.waiting).toEqual({ days: 2, working: true })
  })

  it('accepts working days only for the waiting timeout', () => {
    expect(errors(`${BOARD}timeouts: {stage: 2wd}\n`)).toContainEqual(expect.stringContaining('timeouts.stage'))
  })

  it('turns the stall timeout off with 0', () => {
    expect(config(`${BOARD}timeouts: {stall: 0}\n`).timeouts.stall).toBe(0)
  })

  it('reads personal limits from local.yaml', () => {
    const c = config(BOARD, 'limits: {running: 1, daily_tokens: 2000000}\n')
    expect(c.limits).toMatchObject({ running: 1, awaiting_me: 5, awaiting_review: 2, daily_tokens: 2_000_000 })
  })

  it('reports a missing config.yaml', () => {
    expect(errors()).toContainEqual(expect.stringContaining('config.yaml'))
  })

  it('reports invalid YAML with the file name', () => {
    expect(errors(`${BOARD}stages: [`)).toContainEqual(expect.stringContaining('config.yaml'))
  })

  it('collects all errors', () => {
    expect(
      errors(`board: {provider: jira, project: x}
pickup_from: anywhere
`),
    ).toHaveLength(2)
  })
})
