import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { taskFile, taskOfFile } from './board/board.js'
import type { RepoClone } from './repos.js'
import { GitWorkspaces, runHookScript, type Hooks, type Workspaces } from './workspaces.js'

const NO_HOOKS: Hooks = { timeout: 60_000 }

export class MultiWorkspaces implements Workspaces {
  private parts?: Promise<{ clone: RepoClone; workspaces: GitWorkspaces }[]>

  constructor(
    private readonly options: { root: string; clones: () => Promise<RepoClone[]>; hooks: () => Hooks },
  ) {}

  async prepare(taskId: string) {
    let created = false
    for (const { workspaces } of await this.all()) created = (await workspaces.prepare(taskId)).created || created
    const path = this.path(taskId)
    if (created) {
      try {
        await runHookScript(this.options.hooks(), 'after_create', path)
      } catch (error) {
        await this.removeParts(taskId)
        throw error
      }
    }
    return { path, created }
  }

  async runHook(hook: 'before_run' | 'after_run', path: string) {
    if (hook === 'before_run') return runHookScript(this.options.hooks(), hook, path)
    await runHookScript(this.options.hooks(), hook, path).catch(() => undefined)
  }

  async commitFile(taskId: string, file: string, content: string, message: string) {
    const owner = (await this.all()).find(({ clone }) => file.startsWith(`${clone.name}/`))
    if (!owner) throw new Error(`${file}: an artifact in the repository starts with the name of one of the repositories, for example frontend/docs/plan.md`)
    await owner.workspaces.commitFile(taskId, file.slice(owner.clone.name.length + 1), content, message)
  }

  async commitAll(taskId: string, message: string) {
    let committed = false
    for (const { workspaces } of await this.all()) committed = (await workspaces.commitAll(taskId, message)) || committed
    return committed
  }

  async reset(taskId: string) {
    for (const { workspaces } of await this.all()) await workspaces.reset(taskId)
  }

  async syncBase(taskId: string) {
    let result: 'current' | 'rebased' | 'conflict' = 'current'
    for (const { workspaces } of await this.changedParts(taskId)) {
      const synced = await workspaces.syncBase(taskId)
      if (synced === 'conflict') return 'conflict'
      if (synced === 'rebased') result = 'rebased'
    }
    return result
  }

  async ahead(taskId: string) {
    let total = 0
    for (const { workspaces } of await this.all()) total += await workspaces.ahead(taskId)
    return total
  }

  async changed(taskId: string) {
    return (await this.changedParts(taskId)).map(({ clone }) => clone.name)
  }

  async head() {
    return undefined
  }

  async contains() {
    return false
  }

  async deleteBranch(taskId: string) {
    for (const { workspaces } of await this.all()) await workspaces.deleteBranch(taskId)
  }

  async push(taskId: string) {
    const heads: string[] = []
    for (const { clone, workspaces } of await this.changedParts(taskId)) heads.push(`${clone.name}@${await workspaces.push(taskId)}`)
    return heads.join(',')
  }

  async remove(taskId: string) {
    const path = this.path(taskId)
    if (!existsSync(path)) return
    await runHookScript(this.options.hooks(), 'before_remove', path).catch(() => undefined)
    await this.removeParts(taskId)
  }

  async list() {
    if (!existsSync(this.options.root)) return []
    return readdirSync(this.options.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => taskOfFile(entry.name))
  }

  private async removeParts(taskId: string) {
    for (const { workspaces } of await this.all()) await workspaces.remove(taskId)
    rmSync(this.path(taskId), { recursive: true, force: true })
  }

  private async changedParts(taskId: string) {
    const parts = []
    for (const part of await this.all()) if ((await part.workspaces.ahead(taskId)) > 0) parts.push(part)
    return parts
  }

  private all() {
    this.parts ??= this.options.clones().then((clones) =>
      clones.map((clone) => ({
        clone,
        workspaces: new GitWorkspaces({ repo: clone.path, root: this.options.root, base: async () => clone.base, hooks: () => NO_HOOKS, subdir: clone.name }),
      })),
    )
    return this.parts
  }

  private path(taskId: string) {
    return join(this.options.root, taskFile(taskId))
  }
}
