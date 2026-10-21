import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Run } from '../src/cli.js'
import { stopLeftovers } from '../src/engine/leftovers.js'
import { createRun } from '../src/run.js'
import { tempDir } from './helpers.js'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('stopLeftovers', () => {
  it('stops processes of the task workspace, keeps those of a similar path, and removes the containers of the task', async () => {
    const root = tempDir('conveyor-leftovers-')
    const workspace = join(root, '24')
    const other = join(root, '246')
    mkdirSync(workspace)
    mkdirSync(other)
    const start = (dir: string) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(dir, 'server.js')], { stdio: 'ignore' })
    const mine = start(workspace)
    const theirs = start(other)
    const docker: string[][] = []
    const real = createRun()
    const run: Run = async (command, args) => {
      if (command !== 'docker') return real(command, args)
      docker.push(args)
      return { code: 0, stdout: args[0] === 'ps' ? 'abc123def456789\n' : '', stderr: '' }
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const stopped = await stopLeftovers(run, workspace, '24', 200)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(stopped).toEqual([`process ${mine.pid}`, 'container abc123def456'])
      expect(alive(mine.pid ?? 0)).toBe(false)
      expect(alive(theirs.pid ?? 0)).toBe(true)
      expect(docker).toEqual([
        ['ps', '-aq', '--filter', 'name=^conveyor-24-'],
        ['rm', '-f', 'abc123def456789'],
      ])
    } finally {
      mine.kill('SIGKILL')
      theirs.kill('SIGKILL')
    }
  })
})
