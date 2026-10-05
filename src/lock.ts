import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockFile(home: string, project: string) {
  return join(home, '.conveyor', 'run', `${project.replaceAll('/', '-')}.pid`)
}

export function runningPid(home: string, project: string): number | undefined {
  const file = lockFile(home, project)
  if (!existsSync(file)) return undefined
  const pid = Number(readFileSync(file, 'utf8'))
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined
}

export function acquireRunLock(home: string, project: string): { ok: true; release: () => void } | { ok: false; pid: number } {
  const file = lockFile(home, project)
  const dir = join(home, '.conveyor', 'run')
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'))
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) return { ok: false, pid }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, String(process.pid))
  return {
    ok: true,
    release: () => {
      if (existsSync(file) && readFileSync(file, 'utf8') === String(process.pid)) rmSync(file)
    },
  }
}
