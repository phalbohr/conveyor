import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { Config } from './config.js'
import { spawnLines } from './harness/process.js'
import { createRun } from './run.js'

type Hooks = Config['hooks']
type HookName = 'after_create' | 'before_run' | 'after_run' | 'before_remove'

export interface Workspaces {
  prepare(taskId: string): Promise<{ path: string; created: boolean }>
  runHook(hook: 'before_run' | 'after_run', path: string): Promise<void>
  commitFile(taskId: string, file: string, content: string, message: string): Promise<void>
  commitAll(taskId: string, message: string): Promise<boolean>
  reset(taskId: string): Promise<void>
  deleteBranch(taskId: string): Promise<void>
  push(taskId: string): Promise<string>
  remove(taskId: string): Promise<void>
  list(): Promise<string[]>
}

export const taskBranch = (taskId: string) => `conveyor/${taskId}`

export class GitWorkspaces implements Workspaces {
  constructor(private readonly options: { repo: string; root: string; hooks: () => Hooks }) {}

  async prepare(taskId: string) {
    const path = this.path(taskId)
    if (existsSync(path)) return { path, created: false }

    await this.git(this.options.repo, 'fetch', '--quiet', 'origin')
    const remote = `refs/remotes/origin/${taskBranch(taskId)}`
    const start = (await this.tryGit(this.options.repo, 'rev-parse', '--verify', '--quiet', remote)) ? remote : await this.baseRef()
    mkdirSync(this.options.root, { recursive: true, mode: 0o700 })
    await this.git(this.options.repo, 'worktree', 'add', '--quiet', '-B', taskBranch(taskId), path, start)

    try {
      await this.hook('after_create', path)
    } catch (error) {
      await this.git(this.options.repo, 'worktree', 'remove', '--force', path)
      throw error
    }
    return { path, created: true }
  }

  async runHook(hook: 'before_run' | 'after_run', path: string) {
    if (hook === 'before_run') return this.hook(hook, path)
    await this.hook(hook, path).catch(() => undefined)
  }

  async commitFile(taskId: string, file: string, content: string, message: string) {
    const path = this.path(taskId)
    if (relative(path, join(path, file)).startsWith('..')) throw new Error(`${file} is outside the workspace`)
    let current = path
    for (const part of relative(path, join(path, file)).split(sep)) {
      current = join(current, part)
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${file} goes through a symbolic link`)
    }
    mkdirSync(dirname(join(path, file)), { recursive: true })
    writeFileSync(join(path, file), content)
    await this.git(path, 'add', '--', file)
    await this.git(path, 'commit', '--quiet', '-m', message, '--', file)
  }

  async commitAll(taskId: string, message: string) {
    const path = this.path(taskId)
    await this.git(path, 'add', '--all')
    if ((await this.tryGit(path, 'diff', '--cached', '--quiet')) !== undefined) return false
    await this.git(path, 'commit', '--quiet', '-m', message)
    return true
  }

  async reset(taskId: string) {
    const path = this.path(taskId)
    await this.git(this.options.repo, 'fetch', '--quiet', 'origin')
    await this.git(path, 'reset', '--quiet', '--hard', await this.baseRef())
    await this.git(path, 'clean', '-fdq')
    await this.push(taskId)
  }

  async deleteBranch(taskId: string) {
    await this.tryGit(this.options.repo, 'push', '--quiet', 'origin', '--delete', taskBranch(taskId))
  }

  async push(taskId: string) {
    await this.git(this.path(taskId), 'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${taskBranch(taskId)}`)
    return this.git(this.path(taskId), 'rev-parse', 'HEAD')
  }

  async remove(taskId: string) {
    const path = this.path(taskId)
    if (!existsSync(path)) return
    await this.hook('before_remove', path).catch(() => undefined)
    await this.git(this.options.repo, 'worktree', 'remove', '--force', path)
  }

  async list() {
    if (!existsSync(this.options.root)) return []
    return readdirSync(this.options.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  }

  private path(taskId: string) {
    return join(this.options.root, taskId)
  }

  private async baseRef() {
    const head = await this.tryGit(this.options.repo, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')
    return head ?? 'HEAD'
  }

  private async hook(name: HookName, path: string) {
    const hooks = this.options.hooks()
    const script = hooks[name]
    if (!script) return
    const result = await spawnLines('sh', ['-c', script], {
      cwd: path,
      env: process.env,
      signal: AbortSignal.timeout(hooks.timeout),
      onLine: () => undefined,
    })
    if (result.aborted) throw new Error(`hook ${name} timed out after ${hooks.timeout} ms`)
    if (result.code !== 0) throw new Error(`hook ${name} failed with code ${result.code}: ${result.stderr.trim()}`)
  }

  private async git(cwd: string, ...args: string[]) {
    const result = await createRun(cwd)('git', args)
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }

  private async tryGit(cwd: string, ...args: string[]) {
    const result = await createRun(cwd)('git', args)
    return result.code === 0 ? result.stdout.trim() : undefined
  }
}
