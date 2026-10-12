import { execFile } from 'node:child_process'
import type { Run } from './cli.js'

export function createRun(cwd?: string): Run {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const missing = error?.code === 'ENOENT' ? `${command} is not installed or not in PATH` : ''
        const silent = error && !missing && !stderr.trim() ? `${command} ended without an error message (${error.message.split('\n')[0]})` : ''
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 127) : 0, stdout, stderr: missing || silent || stderr })
      })
    })
}
