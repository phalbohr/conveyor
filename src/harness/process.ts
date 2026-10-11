import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const STDERR_LIMIT = 64 * 1024
const BUSY_CHECK = 30_000
const BUSY_SHARE = 0.05

export type LinesResult = { code: number | null; stderr: string; aborted: boolean; error?: string }

export function spawnLines(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onLine: (line: string) => void; onBusy?: () => void; busyCheckMs?: number },
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
    const every = options.busyCheckMs ?? BUSY_CHECK
    let used = 0
    const busy =
      options.onBusy && child.pid !== undefined
        ? setInterval(() => {
            void groupCpu(child.pid as number).then((cpu) => {
              if (cpu === undefined) return
              if (cpu - used >= (BUSY_SHARE * every) / 1000) options.onBusy?.()
              used = cpu
            })
          }, every)
        : undefined
    child.on('close', (code) => {
      clearInterval(busy)
      options.signal?.removeEventListener('abort', killTree)
      resolve({ code, stderr, aborted: options.signal?.aborted ?? false, ...(error ? { error } : {}) })
    })
  })
}

function groupCpu(group: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pgid=,time='], (error, stdout) => {
      if (error) return resolve(undefined)
      let total = 0
      for (const line of stdout.split('\n')) {
        const [pgid, time] = line.trim().split(/\s+/)
        if (Number(pgid) === group && time) total += seconds(time)
      }
      resolve(total)
    })
  })
}

function seconds(time: string) {
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
  return (clock ?? '').split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86_400
}
