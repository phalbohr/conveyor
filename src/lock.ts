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

export function acquireRunLock(home: string, project: string): { ok: true; release: () => void } | { ok: false; pid: number } {
  const dir = join(home, '.conveyor', 'run')
  const file = join(dir, `${project.replaceAll('/', '-')}.pid`)
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
