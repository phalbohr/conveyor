import { execFile } from 'node:child_process'
import type { Run } from './cli.js'

const COMMAND_TIMEOUT = 10 * 60_000

export function createRun(cwd?: string, timeout = COMMAND_TIMEOUT): Run {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        const missing = error?.code === 'ENOENT' ? `${command} is not installed or not in PATH` : ''
        const stalled = error?.killed && !missing ? `${command} ${args.slice(0, 2).join(' ')} did not finish in ${Math.round(timeout / 1000)} s and was stopped; the network may be down` : ''
        const silent = error && !missing && !stalled && !stderr.trim() && !stdout.trim() ? `${command} ended without an error message (${error.message.split('\n')[0]})` : ''
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 127) : 0, stdout, stderr: missing || stalled || silent || stderr })
      })
    })
}
