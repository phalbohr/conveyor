import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from './helpers.js'

async function project() {
  const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
  const cli = (...argv: string[]) => runCli(argv, { cwd: init.context.cwd, home: init.context.home })
  const file = (name: string) => readFileSync(join(init.context.cwd, '.conveyor', name), 'utf8')
  return { cli, file }
}

describe('conveyor config', () => {
  it('lists every setting with value, options, and description', async () => {
    const { cli } = await project()
    const fields = JSON.parse((await cli('config', 'list', '--json')).stdout) as { key: string; value: string; help: string }[]
    expect(fields.find((field) => field.key === 'transitions.merge')).toMatchObject({ value: 'human', options: ['human', 'ai', 'smart'] })
    expect(fields.every((field) => field.help)).toBe(true)
    const text = (await cli('config', 'list')).stdout
    expect(text).toContain('transitions.merge = human [human|ai|smart]')
    expect(text).toContain('agent CLI that runs the stage')
  })

  it('gets and sets a value', async () => {
    const { cli, file } = await project()
    expect((await cli('config', 'get', 'merge_method')).stdout).toBe('merge\n')
    const set = await cli('config', 'set', 'stages.review.model', 'sonnet')
    expect(set).toMatchObject({ code: 0, stdout: 'Saved stages.review.model = sonnet\n' })
    expect(file('config.yaml')).toContain('review: {model: sonnet, effort: high}')
  })

  it('refuses an invalid value and keeps the file', async () => {
    const { cli, file } = await project()
    const result = await cli('config', 'set', 'limits.running', '0')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('limits.running')
    expect(file('local.yaml')).toContain('running: 3')
  })

  it('rejects an unknown key', async () => {
    const { cli } = await project()
    const result = await cli('config', 'get', 'nope')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('conveyor config list')
  })

  it('adds, moves, and removes stages', async () => {
    const { cli, file } = await project()
    expect((await cli('config', 'stage', 'add', 'polish')).code).toBe(0)
    expect((await cli('config', 'stage', 'add', 'fix-ci', '--after-merge', '--when', 'failure')).code).toBe(0)
    expect((await cli('config', 'stage', 'move', 'polish', 'up')).stdout).toContain('story → plan → implement → polish → review → merge → fix-ci')
    expect(file('config.yaml')).toContain('fix-ci: {when: failure}')
    expect((await cli('config', 'stage', 'remove', 'plan')).stderr).toContain('reserved')
    expect((await cli('config', 'stage', 'remove', 'polish')).code).toBe(0)
    expect(file('config.yaml')).not.toContain('polish')
  })
})
