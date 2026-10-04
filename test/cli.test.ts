import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCli } from './helpers.js'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('conveyor CLI', () => {
  it('prints the version', async () => {
    const result = await runCli(['--version'])
    expect(result).toMatchObject({ code: 0, stdout: `${version}\n`, stderr: '' })
  })

  it('prints the version as JSON', async () => {
    const result = await runCli(['--version', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ version })
  })

  it('prints help', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: conveyor')
  })

  it('fails on an unknown option', async () => {
    const result = await runCli(['--nope'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--nope')
  })
})
