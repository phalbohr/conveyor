import { probesOf, type Context } from '../cli.js'
import { loadConfig } from '../config.js'
import { ModelCache, catalogsFor } from '../models.js'
import { Runner, type RunnerSetup } from '../runner.js'
import { SettingsDocument } from '../settings-editor.js'
import { collectStatus } from '../status.js'
import { showSettings } from '../ui/settings-screen.js'
import { showStatus } from '../ui/status-screen.js'
import type { TaskControl } from '../ui/task-lines.js'
import { commentText, findWorkpad } from '../engine/workpad.js'
import { agentCommand, attachCommand, newCommand } from './live.js'
import { modelsFile } from './models.js'
import { releaseCommand } from './run.js'

export async function hub(context: Context, setup: RunnerSetup, options: { start?: boolean } = {}): Promise<number> {
  const runner = new Runner(context, setup)
  const load = async () => {
    const current = loadConfig(setup.settings)
    if (!current.ok) throw new Error(current.errors.join('; '))
    return collectStatus({ board: setup.board, config: current.config, settings: setup.settings, home: context.home })
  }
  const board = setup.board
  const control: TaskControl = {
    async detail(id) {
      const task = await board.getTask(id)
      if (!task) throw new Error(`task ${id} not found`)
      const comments = await board.listComments(id)
      const pad = findWorkpad(comments)
      const pull = await board.pullRequest(id)
      return {
        task,
        ...(pad ? { workpad: { text: pad.text, ...(pad.state.stage ? { stage: pad.state.stage } : {}) } } : {}),
        comments: comments.filter((comment) => comment.id !== pad?.id).map((comment) => ({ ...comment, body: commentText(comment) })),
        ...(pull ? { pull } : {}),
      }
    },
    async comment(id, target, body) {
      if (target === 'pull') await board.commentPullRequest(id, body)
      else await board.addComment(id, body)
    },
    async toggleIdea(id) {
      const task = await board.getTask(id)
      if (!task) throw new Error(`task ${id} not found`)
      if (task.form && task.form !== 'idea') return `#${id} has form::${task.form}; change it on the board.`
      await board.setForm(id, task.form ? undefined : 'idea')
      if (!task.state) await board.setState(id, 'backlog')
      return task.form ? `Removed form::idea from #${id}.` : `Set form::idea on #${id}: the conveyor may take it.`
    },
    async open(url) {
      const opened = await context.run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
      if (opened.code !== 0) throw new Error(`could not open ${url}`)
    },
    async openBoard() {
      await this.open(await board.boardUrl())
    },
  }
  let notice: string | undefined
  if (options.start) {
    const started = await runner.start()
    if (!started.ok) notice = started.error
  }

  for (;;) {
    const action = await showStatus(load, { runner, control, ...(notice ? { notice } : {}) })
    notice = undefined
    if (action.kind === 'quit') {
      if (runner.running) context.stdout('Stopping the conveyor: running stages are aborted, tasks resume on the next start.\n')
      await runner.stop()
      return 0
    }
    if (action.kind === 'settings') {
      await openSettings(context, setup.settings)
      continue
    }
    let output = ''
    const captured: Context = { ...context, stdout: (text) => (output += text), stderr: (text) => (output += text) }
    if (action.kind === 'new') await newCommand(captured, false)
    if (action.kind === 'attach') await attachCommand(captured, action.id)
    if (action.kind === 'release') await releaseCommand(captured, action.id, false)
    if (action.kind === 'agent') await agentCommand(captured, action.id)
    notice = output.trim() || undefined
  }
}

export async function openSettings(context: Context, settings: string) {
  const loaded = loadConfig(settings)
  if (!loaded.ok) {
    await showSettings(new SettingsDocument(settings))
    return
  }
  const config = loaded.config
  const cache = new ModelCache(modelsFile(context.home, config.board.project))
  const harnesses = ['claude', 'codex', ...Object.keys(config.harnesses)]
  const probes = probesOf(context)
  const catalogs = await catalogsFor(harnesses, config, probes, cache, false)
  await showSettings(new SettingsDocument(settings, { catalogs }), () => catalogsFor(harnesses, config, probes, cache, true))
}
