import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.js'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

async function run(...argv: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) })
  return { code, stdout, stderr }
}

describe('conveyor CLI', () => {
  it('prints the version', async () => {
    expect(await run('--version')).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' })
  })

  it('prints the version as JSON', async () => {
    const result = await run('--version', '--json')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ version })
  })

  it('prints help without arguments', async () => {
    const result = await run()
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: conveyor')
  })

  it('fails on an unknown option', async () => {
    const result = await run('--nope')
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--nope')
  })
})
