import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { spawnLines } from '../src/harness/process.js'
import { tempDir } from './helpers.js'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('spawnLines', () => {
  it('kills the whole process tree on abort', async () => {
    const dir = tempDir()
    const pidFile = join(dir, 'grandchild.pid')
    const controller = new AbortController()
    const script = `sleep 60 & echo $! > ${pidFile}; echo started; wait`
    const pending = spawnLines('sh', ['-c', script], {
      cwd: dir,
      env: process.env,
      signal: controller.signal,
      onLine: () => controller.abort(),
    })

    const result = await pending
    const grandchild = Number(readFileSync(pidFile, 'utf8'))

    expect(result.aborted).toBe(true)
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false))
  })

  it('streams lines and returns the exit code', async () => {
    const lines: string[] = []
    const result = await spawnLines('sh', ['-c', 'echo one; echo two; exit 4'], { cwd: tempDir(), env: process.env, onLine: (line) => lines.push(line) })
    expect(lines).toEqual(['one', 'two'])
    expect(result).toMatchObject({ code: 4, aborted: false })
  })
})
