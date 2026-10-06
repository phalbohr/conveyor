import { createRun } from './run.js'

export type SettingsSync =
  | { state: 'current' }
  | { state: 'behind'; base: string; commits: string[] }
  | { state: 'unknown'; reason: string }

export async function checkSettingsSync(settingsDir: string, options: { fetch: boolean }): Promise<SettingsSync> {
  const git = async (cwd: string, ...args: string[]) => {
    const result = await createRun(cwd)('git', args)
    return result.code === 0 ? result.stdout.trim() : undefined
  }
  const root = await git(settingsDir, 'rev-parse', '--show-toplevel')
  if (!root) return { state: 'unknown', reason: 'the settings are not in a git repository' }
  if (options.fetch && (await git(root, 'fetch', '--quiet', 'origin')) === undefined) {
    return { state: 'unknown', reason: 'git fetch origin failed' }
  }
  const head = await git(root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
  const base = head ?? ((await git(root, 'rev-parse', '--verify', '--quiet', 'origin/main')) ? 'origin/main' : undefined)
  if (!base) return { state: 'unknown', reason: 'no main branch on origin' }
  const path = (await git(settingsDir, 'rev-parse', '--show-prefix')) || '.'
  const log = await git(root, 'log', '--format=%h %an, %ar: %s', `HEAD..${base}`, '--', path)
  if (log === undefined) return { state: 'unknown', reason: 'git log failed' }
  const commits = log.split('\n').filter(Boolean)
  return commits.length > 0 ? { state: 'behind', base, commits } : { state: 'current' }
}

export function syncNotice(sync: Extract<SettingsSync, { state: 'behind' }>) {
  const count = `${sync.commits.length} commit${sync.commits.length === 1 ? '' : 's'}`
  return `Team settings are behind ${sync.base} by ${count}. Run \`git pull\` to get them:\n${sync.commits.map((commit) => `  ${commit}`).join('\n')}`
}
