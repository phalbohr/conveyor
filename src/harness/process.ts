import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const STDERR_LIMIT = 64 * 1024

export type LinesResult = { code: number | null; stderr: string; aborted: boolean; error?: string }

export function spawnLines(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onLine: (line: string) => void },
): Promise<LinesResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const killTree = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    options.signal?.addEventListener('abort', killTree, { once: true })
    if (options.signal?.aborted) killTree()

    let stderr = ''
    let error: string | undefined
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT)))
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim()) options.onLine(line)
    })
    child.on('error', (cause) => (error = cause.message))
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', killTree)
      resolve({ code, stderr, aborted: options.signal?.aborted ?? false, ...(error ? { error } : {}) })
    })
  })
}
