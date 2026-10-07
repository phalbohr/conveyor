import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FakeHarness, type Script } from '../src/harness/fake.js'
import type { StageRun } from '../src/harness/harness.js'
import type { Workspaces } from '../src/workspaces.js'
import { tempDir } from './helpers.js'

export class FakeWorkspaces implements Workspaces {
  readonly root = tempDir('conveyor-fake-ws-')
  readonly hooks: string[] = []
  readonly commits: { taskId: string; file: string; content: string }[] = []
  readonly pushes: string[] = []
  readonly stageCommits: string[] = []
  readonly removed: string[] = []
  readonly resets: string[] = []
  readonly deletedBranches: string[] = []
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

  async reset(taskId: string) {
    this.resets.push(taskId)
  }

  async deleteBranch(taskId: string) {
    this.deletedBranches.push(taskId)
  }

  async push(taskId: string) {
    this.pushes.push(taskId)
    return taskId.padStart(40, '0')
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

export function stageHarness(script: Script = () => ({ outcome: 'done', summary: 'ok' })) {
  let stages = 0
  return new FakeHarness((run) =>
    run.stage === 'triage'
      ? { outcome: 'done', summary: 'triaged', artifact: { kind: 'triage', content: '{"tasks": []}' } }
      : script(run, stages++),
  )
}

export function stageRuns(harness: FakeHarness): StageRun[] {
  return harness.runs.filter((run) => run.stage !== 'triage')
}
