import { execFile } from 'node:child_process'
import type { Run } from './cli.js'

export function createRun(cwd?: string): Run {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 127) : 0, stdout, stderr })
      })
    })
}
