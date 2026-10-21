import type { Run } from '../cli.js'

export function containerPrefix(slug: string) {
  return `conveyor-${slug}-`
}

export async function stopLeftovers(run: Run, workspace: string, slug: string, grace = 5_000): Promise<string[]> {
  const stopped: string[] = []
  const listed = await run('ps', ['-eo', 'pid=,args='])
  if (listed.code === 0 && workspace) {
    const pids = listed.stdout
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .filter(([, , command = '']) => command.includes(`${workspace}/`) || command.includes(`${workspace} `) || command.endsWith(workspace))
      .map(([, pid]) => Number(pid))
      .filter((pid) => pid !== process.pid)
    for (const pid of pids) if (signal(pid, 'SIGTERM')) stopped.push(`process ${pid}`)
    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, grace))
      for (const pid of pids) signal(pid, 'SIGKILL')
    }
  }
  const containers = await run('docker', ['ps', '-aq', '--filter', `name=^${containerPrefix(slug)}`])
  const ids = containers.code === 0 ? containers.stdout.split('\n').map((id) => id.trim()).filter(Boolean) : []
  if (ids.length > 0 && (await run('docker', ['rm', '-f', ...ids])).code === 0) stopped.push(...ids.map((id) => `container ${id.slice(0, 12)}`))
  return stopped
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
    return true
  } catch {
    return false
  }
}
