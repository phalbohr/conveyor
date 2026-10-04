import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Workspaces } from '../src/workspaces.js'
import { tempDir } from './helpers.js'

export class FakeWorkspaces implements Workspaces {
  readonly root = tempDir('conveyor-fake-ws-')
  readonly hooks: string[] = []
  readonly commits: { taskId: string; file: string; content: string }[] = []
  readonly pushes: string[] = []
  readonly stageCommits: string[] = []
  readonly removed: string[] = []
  failBeforeRun = false

  async prepare(taskId: string) {
    const path = join(this.root, taskId)
    const created = !existsSync(path)
    mkdirSync(path, { recursive: true })
    return { path, created }
  }

  async runHook(hook: 'before_run' | 'after_run', path: string) {
    this.hooks.push(`${hook}:${basename(path)}`)
    if (hook === 'before_run' && this.failBeforeRun) throw new Error('hook before_run failed with code 1')
  }

  async commitFile(taskId: string, file: string, content: string) {
    const path = join(this.root, taskId, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    this.commits.push({ taskId, file, content })
  }

  async commitAll(taskId: string, message: string) {
    this.stageCommits.push(`${taskId}:${message}`)
    return true
  }

  async push(taskId: string) {
    this.pushes.push(taskId)
  }

  async remove(taskId: string) {
    rmSync(join(this.root, taskId), { recursive: true, force: true })
    this.removed.push(taskId)
  }

  async list() {
    return readdirSync(this.root)
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
