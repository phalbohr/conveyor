import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from './cli.js'
import { loadConfig, type Config } from './config.js'
import { FORM_LABEL, STATE_LABEL, TASK_FORMS, TASK_STATES, type TaskState } from './board/board.js'
import { boardAdapter } from './commands/run.js'
import { setUpProject } from './project-setup.js'
import { SETTINGS_DIR, findSettings, linkSettings } from './settings.js'

export type Board = Config['board']
export type Target = { kind: 'here' } | { kind: 'path'; path: string } | { kind: 'use'; path: string }
export type BoardTarget = { kind: 'project' } | { kind: 'group'; projects: string[] } | { kind: 'missing'; error: string }
export type InitResult = { ok: true; settings: string; warnings: string[]; board: string[]; next: string } | { ok: false; errors: string[] }

type Check = [command: string, args: string[]]

const COLUMNS: TaskState[] = ['backlog', 'needs-input', 'queued', 'in-progress', 'review', 'done']

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url))
const BOARD_TOOLS: Record<Board['provider'], Check> = { github: ['gh', ['auth', 'status']], gitlab: ['glab', ['auth', 'status']] }
const HARNESS_TOOLS: Record<string, Check> = { claude: ['claude', ['--version']], codex: ['codex', ['--version']] }

const REMOTE = /^(?:[\w.-]+@([^:/]+):|https?:\/\/(?:[^@/]+@)?([^/]+)\/)(.+?)(?:\.git)?\/?$/

export function parseRemote(url: string): Board | undefined {
  const match = url.trim().match(REMOTE)
  if (!match?.[3]) return undefined
  const host = match[1] ?? match[2] ?? ''
  const path = match[3].replace(/\/-\/.*$/, '').replace(/^groups\//, '')
  if (host === 'github.com') return { provider: 'github', project: path.split('/').slice(0, 2).join('/') }
  if (host.includes('gitlab')) return { provider: 'gitlab', project: path }
  return undefined
}

export function boardPath(input: string) {
  const trimmed = input.trim()
  return /^[\w.-]+@|:\/\//.test(trimmed) ? (parseRemote(trimmed)?.project ?? trimmed) : trimmed.replace(/\/+$/, '')
}

function urlHost(input: string) {
  const match = input.trim().match(REMOTE)
  return match ? (match[1] ?? match[2] ?? '').replace(/:\d+$/, '').toLowerCase() : undefined
}

async function toolHost(context: Context, provider: Board['provider']) {
  if (provider === 'github') return (process.env.GH_HOST || 'github.com').toLowerCase()
  const env = process.env.GITLAB_HOST || process.env.GL_HOST
  if (env) return urlHost(env.includes('://') ? `${env}/x` : `https://${env}/x`) ?? env.toLowerCase()
  const origin = await context.run('git', ['remote', 'get-url', 'origin'])
  const remote = origin.code === 0 && parseRemote(origin.stdout)?.provider === 'gitlab' ? urlHost(origin.stdout) : undefined
  if (remote) return remote
  const config = await context.run('glab', ['config', 'get', 'host'])
  return (config.code === 0 && config.stdout.trim().toLowerCase()) || 'gitlab.com'
}

export async function boardTarget(context: Context, provider: Board['provider'], input: string): Promise<BoardTarget> {
  const path = boardPath(input)
  const host = urlHost(input)
  if (host) {
    const tool = await toolHost(context, provider)
    if (host !== tool) {
      const cli = provider === 'github' ? 'gh' : 'glab'
      return { kind: 'missing', error: `the URL points to ${host}, but ${cli} works with ${tool}; sign in to ${host} (${cli} auth login --hostname ${host}) and make it the host of ${cli}, or enter the path of a board on ${tool}` }
    }
  }
  if (provider === 'github') {
    const repo = await context.run('gh', ['api', `repos/${path}`, '--jq', '.full_name'])
    return repo.code === 0 ? { kind: 'project' } : { kind: 'missing', error: `GitHub repository ${path} was not found, or you have no access to it: ${repo.stderr.trim() || 'no answer from gh'}` }
  }
  const project = await context.run('glab', ['api', `projects/${encodeURIComponent(path)}`])
  if (project.code === 0) return { kind: 'project' }
  const list = (page: number) => context.run('glab', ['api', `groups/${encodeURIComponent(path)}/projects?include_subgroups=true&archived=false&per_page=100&order_by=path&sort=asc&page=${page}`])
  let group = await list(1)
  if (group.code === 0) {
    const projects: string[] = []
    for (let page = 1; group.code === 0; group = await list(++page)) {
      const batch = JSON.parse(group.stdout || '[]') as { path_with_namespace: string }[]
      projects.push(...batch.map((entry) => entry.path_with_namespace))
      if (batch.length < 100) break
    }
    return { kind: 'group', projects }
  }
  return { kind: 'missing', error: `GitLab project or group ${path} was not found, or you have no access to it: ${(project.stderr || project.stdout).trim() || 'no answer from glab'}` }
}

async function checkBoardTarget(context: Context, input: Board): Promise<{ ok: true; board: Board } | { ok: false; errors: string[] }> {
  const board: Board = { ...input, project: boardPath(input.project), ...(input.group ? { group: boardPath(input.group) } : {}) }
  if (board.group && board.provider === 'gitlab') {
    const group = await boardTarget(context, 'gitlab', input.group ?? board.group)
    if (group.kind === 'missing') return { ok: false, errors: [group.error] }
    if (group.kind !== 'group') return { ok: false, errors: [`${board.group} is a GitLab project, not a group`] }
    if (!group.projects.includes(board.project)) return { ok: false, errors: [`${board.project} is not a project of the group ${board.group}; choose one of: ${group.projects.join(', ') || 'none'}`] }
    return { ok: true, board }
  }
  const target = await boardTarget(context, board.provider, input.project)
  if (target.kind === 'missing') return { ok: false, errors: [target.error] }
  if (target.kind === 'group') {
    return { ok: false, errors: [`${board.project} is a GitLab group. For a group board, name the project for new tasks: conveyor init --provider gitlab --group ${board.project} --project ${target.projects[0] ?? `${board.project}/<project>`}`] }
  }
  return { ok: true, board }
}

export async function detectBoard(context: Context): Promise<Partial<Board>> {
  const { code, stdout } = await context.run('git', ['remote', 'get-url', 'origin'])
  return (code === 0 && parseRemote(stdout)) || {}
}

export async function initProject(context: Context, target: Target, board?: Board): Promise<InitResult> {
  const existing = findSettings(context.cwd, context.home)
  if (existing) return { ok: false, errors: [`conveyor is already initialized here: ${existing}`] }

  if (target.kind === 'use') {
    const settings = resolve(context.cwd, target.path)
    const loaded = loadConfig(settings)
    if (!loaded.ok) return loaded
    linkSettings(context.cwd, context.home, settings)
    return finish(context, settings, loaded.config)
  }

  if (!board) return { ok: false, errors: ['the board is unknown: pass --provider and --project'] }
  const settings = target.kind === 'here' ? join(context.cwd, SETTINGS_DIR) : resolve(context.cwd, target.path)
  if (existsSync(join(settings, 'config.yaml'))) return { ok: false, errors: [`settings already exist: ${settings}`] }
  const checked = await checkBoardTarget(context, board)
  if (!checked.ok) return { ok: false, errors: [...checked.errors, 'Nothing was created.'] }

  const created = createSettings(settings, checked.board)
  const loaded = loadConfig(settings)
  if (!loaded.ok) {
    created()
    return { ok: false, errors: [...loaded.errors, 'Nothing was created.'] }
  }
  if (target.kind === 'path') linkSettings(context.cwd, context.home, settings)
  return finish(context, settings, loaded.config)
}

async function finish(context: Context, settings: string, config: Config): Promise<InitResult> {
  const warnings = await checkTools(config, context)
  let current = config
  const project = await setUpProject(boardAdapter(context, config), config, settings).catch((error: unknown) => {
    warnings.push(`the GitHub project was not set up: ${(error as Error).message}`)
    return {} as { number?: number; message?: string }
  })
  if (project.number) {
    const reloaded = loadConfig(settings)
    if (reloaded.ok) current = reloaded.config
  }
  if (project.message && !project.number) warnings.push(project.message)
  const labeled = await boardAdapter(context, current)
    .prepare(current.stages.map((stage) => stage.name))
    .then(() => true)
    .catch((error: unknown) => {
      warnings.push(`the board labels were not created: ${(error as Error).message}`)
      return false
    })
  const where = current.board.group ? `group ${current.board.group}` : `project ${current.board.project}`
  const next = labeled
    ? `Initialization is done, and the conveyor exits now. Next: set up the board columns as described above, then start the conveyor again with: conveyor`
    : `Initialization is done, but the labels are missing in ${where}, and the conveyor exits now. Next: fix the cause in the warning above, run conveyor board update to create the labels, set up the board columns as described above, then start the conveyor with: conveyor`
  return { ok: true, settings, warnings, board: [...(project.number && project.message ? [project.message] : []), ...boardSteps(current, labeled)], next }
}

function boardSteps(config: Config, labeled: boolean): string[] {
  const where = config.board.group ? `group ${config.board.group}` : `project ${config.board.project}`
  const labels = `${labeled ? `Created the labels in ${where}` : 'Labels'}: ${TASK_STATES.map((state) => STATE_LABEL + state).join(', ')}; ${TASK_FORMS.map((form) => FORM_LABEL + form).join(', ')}; stage:: for every stage.`
  const columns = COLUMNS.map((state) => STATE_LABEL + state).join(', ')
  if (config.board.provider === 'gitlab') return [labels, `Board: in the ${where}, open Plan → Issue boards and add one list per label, in this order: ${columns}.`]
  if (config.board.github_project) {
    return [labels, `Board: in project ${config.board.github_project}, open a Board view and choose the field Conveyor under "Column by".`]
  }
  return [
    labels,
    'Board: choose the GitHub project (conveyor config set board.github_project <number>), run conveyor board update to add the field Conveyor, then choose the field Conveyor under "Column by" in a Board view.',
  ]
}

function createSettings(dir: string, board: Board) {
  const fresh = !existsSync(dir)
  const before = new Set(fresh ? [] : readdirSync(dir))
  mkdirSync(dir, { recursive: true })
  for (const entry of ['stages', 'smart', 'live', 'formats', 'triage.md', 'local.yaml']) {
    cpSync(join(TEMPLATES, entry), join(dir, entry), { recursive: true })
  }
  cpSync(join(TEMPLATES, 'gitignore'), join(dir, '.gitignore'))
  const config = readFileSync(join(TEMPLATES, 'config.yaml'), 'utf8')
    .replace('{{provider}}', board.provider)
    .replace('{{project}}', `${JSON.stringify(board.project)}${board.group ? `\n  group: ${JSON.stringify(board.group)}` : ''}`)
  writeFileSync(join(dir, 'config.yaml'), config)
  return () => {
    if (fresh) rmSync(dir, { recursive: true, force: true })
    else for (const entry of readdirSync(dir)) if (!before.has(entry)) rmSync(join(dir, entry), { recursive: true, force: true })
  }
}

async function checkTools(config: Config, context: Context): Promise<string[]> {
  const harnesses = new Set([config.triage.harness, ...config.stages.map((stage) => stage.harness)])
  const checks = [
    BOARD_TOOLS[config.board.provider],
    ...[...harnesses].map((harness): Check => HARNESS_TOOLS[harness] ?? ['sh', ['-c', 'command -v -- "$1"', 'sh', config.harnesses[harness]?.command ?? harness]]),
  ]
  const warnings: string[] = []
  for (const [command, args] of checks) {
    const { code } = await context.run(command, args)
    if (code !== 0) warnings.push(`\`${[command, ...args].join(' ')}\` failed: install ${command} and sign in`)
  }
  return warnings
}
