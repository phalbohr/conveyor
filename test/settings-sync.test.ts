import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { checkSettingsSync } from '../src/settings-sync.js'
import { runCli, tempDir } from './helpers.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function team() {
  const origin = join(tempDir('conveyor-origin-'), 'origin.git')
  git(tempDir(), 'init', '--bare', '--initial-branch=main', origin)
  const clone = (name: string) => {
    const dir = join(tempDir(`conveyor-${name}-`), 'repo')
    git(join(dir, '..'), 'clone', '--quiet', origin, 'repo')
    git(dir, 'config', 'user.email', `${name}@example.com`)
    git(dir, 'config', 'user.name', name)
    return dir
  }
  const alice = clone('alice')
  mkdirSync(join(alice, '.conveyor'))
  writeFileSync(join(alice, '.conveyor', 'config.yaml'), 'board: {provider: github, project: acme/app}\n')
  writeFileSync(join(alice, 'README.md'), 'app\n')
  git(alice, 'add', '.')
  git(alice, 'commit', '--quiet', '-m', 'Add conveyor settings')
  git(alice, 'push', '--quiet', 'origin', 'main')
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const bob = clone('bob')
  const commit = (dir: string, file: string, content: string, message: string) => {
    writeFileSync(join(dir, file), content)
    git(dir, 'add', '.')
    git(dir, 'commit', '--quiet', '-m', message)
    git(dir, 'push', '--quiet', 'origin', 'HEAD:main')
  }
  return { alice, bob, commit }
}

describe('checkSettingsSync', () => {
  it('reports newer team settings on the main branch', async () => {
    const { alice, bob, commit } = team()
    commit(alice, '.conveyor/config.yaml', 'board: {provider: github, project: acme/app}\npickup_from: story\n', 'Take stories')

    const sync = await checkSettingsSync(join(bob, '.conveyor'), { fetch: true, base: 'main' })

    expect(sync).toMatchObject({ state: 'behind', base: 'origin/main' })
    expect(sync.state === 'behind' && sync.commits[0]).toContain('Take stories')
  })

  it('is current after a pull and ignores changes outside the settings', async () => {
    const { alice, bob, commit } = team()
    commit(alice, '.conveyor/config.yaml', 'board: {provider: github, project: acme/app}\npickup_from: story\n', 'Take stories')
    git(bob, 'pull', '--quiet')
    commit(alice, 'README.md', 'changed\n', 'Docs')

    expect(await checkSettingsSync(join(bob, '.conveyor'), { fetch: true, base: 'main' })).toEqual({ state: 'current' })
  })

  it('ignores my own uncommitted and unpushed changes', async () => {
    const { bob } = team()
    writeFileSync(join(bob, '.conveyor', 'config.yaml'), 'board: {provider: github, project: acme/app}\npickup_from: idea\n')
    expect(await checkSettingsSync(join(bob, '.conveyor'), { fetch: true, base: 'main' })).toEqual({ state: 'current' })
  })

  it('skips settings outside git', async () => {
    expect(await checkSettingsSync(tempDir(), { fetch: true, base: 'main' })).toMatchObject({ state: 'unknown' })
  })
})

describe('notices about newer team settings', () => {
  it('conveyor run warns once per change', async () => {
    const { alice, bob, commit } = team()
    writeFileSync(join(bob, '.conveyor', 'config.yaml'), 'board: {provider: github, project: acme/app}\n')
    commit(alice, '.conveyor/config.yaml', 'board: {provider: github, project: acme/app}\nmerge_method: squash\n', 'Squash merges')

    const result = await runCli(['run', '--once'], { cwd: bob, board: new FakeBoard('me') })

    expect(result.stderr).toContain('Team settings are behind origin/main by 1 commit')
    expect(result.stderr).toContain('Squash merges')
    expect(result.stderr).toContain('git pull')
  })

  it('the status shows the notice', async () => {
    const { alice, bob, commit } = team()
    commit(alice, '.conveyor/config.yaml', 'board: {provider: github, project: acme/app}\nmerge_method: squash\n', 'Squash merges')
    const result = await runCli(['--json'], { cwd: bob, board: new FakeBoard('me') })
    expect(JSON.parse(result.stdout).status.settingsSync).toMatchObject({ state: 'behind', commits: [expect.stringContaining('Squash merges')] })

    const text = await runCli([], { cwd: bob, board: new FakeBoard('me') })
    expect(text.stdout).toContain('Team settings are behind origin/main by 1 commit')
  })
})
