import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Board, Comment, Task } from '../board/board.js'
import type { Config } from '../config.js'
import { expandPath } from '../paths.js'
import type { Workspaces } from '../workspaces.js'
import { agentComment, commentText } from './workpad.js'

type Kind = keyof Config['artifacts']

const ARTIFACT = (kind: string) => `<!-- conveyor:artifact:${kind} -->`
const fileName = (taskId: string, kind: string) => `${taskId}-${kind}.md`

export class Artifacts {
  constructor(
    private readonly board: Board,
    private readonly workspaces: Workspaces,
    private readonly config: Config,
    private readonly home: string,
  ) {}

  async store(task: Task, kind: string, content: string, comments: Comment[]) {
    const storage = this.config.artifacts[kind as Kind] ?? { store: 'board', write: 'replace' }
    if (storage.store === 'path' && storage.path) {
      const file = join(this.expand(storage.path), fileName(task.id, kind))
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, content, { mode: 0o600 })
      return
    }
    if (storage.store === 'repo' && storage.path) {
      await this.workspaces.commitFile(task.id, join(storage.path, fileName(task.id, kind)), content, `Add ${kind} for task ${task.id}`)
      return
    }
    if (kind === 'idea' || kind === 'story') {
      await this.board.updateBody(task.id, storage.write === 'append' && task.body ? `${task.body}\n\n---\n\n${content}` : content)
      return
    }
    const body = agentComment(`artifact:${kind}`, `### ${kind}\n\n${content}`)
    const existing = comments.find((comment) => comment.body.startsWith(ARTIFACT(kind)))
    if (existing) await this.board.updateComment(existing.id, body)
    else await this.board.addComment(task.id, body)
  }

  read(task: Task, comments: Comment[], workspace: string): Record<string, string> {
    const artifacts: Record<string, string> = {}
    for (const comment of comments) {
      const kind = comment.body.match(/^<!-- conveyor:artifact:([\w-]+) -->/)?.[1]
      if (kind) artifacts[kind] = commentText(comment).replace(/^### [\w-]+\n\n/, '')
    }
    for (const [kind, storage] of Object.entries(this.config.artifacts)) {
      if (!storage.path || storage.store === 'board') continue
      const base = storage.store === 'repo' ? join(workspace, storage.path) : this.expand(storage.path)
      const file = join(base, fileName(task.id, kind))
      if (existsSync(file)) artifacts[kind] = readFileSync(file, 'utf8')
    }
    return artifacts
  }

  private expand(path: string) {
    return expandPath(path, { home: this.home, project: this.config.board.project })
  }
}
