import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from './cli.js'
import { loadConfig, type Config } from './config.js'
import { STATE_LABEL, TASK_STATES } from './board/board.js'
import { boardAdapter } from './commands/run.js'
import { SETTINGS_DIR, findSettings, linkSettings } from './settings.js'

export type Board = Config['board']
export type Target = { kind: 'here' } | { kind: 'path'; path: string } | { kind: 'use'; path: string }
export type InitResult = { ok: true; settings: string; warnings: string[]; board: string[] } | { ok: false; errors: string[] }

type Check = [command: string, args: string[]]

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url))
const BOARD_TOOLS: Record<Board['provider'], Check> = { github: ['gh', ['auth', 'status']], gitlab: ['glab', ['auth', 'status']] }
const HARNESS_TOOLS: Record<string, Check> = { claude: ['claude', ['--version']], codex: ['codex', ['--version']] }

export function parseRemote(url: string): Board | undefined {
  const match = url.trim().match(/^(?:[\w.-]+@([^:/]+):|https?:\/\/(?:[^@/]+@)?([^/]+)\/)(.+?)(?:\.git)?\/?$/)
  if (!match?.[3]) return undefined
  const host = match[1] ?? match[2] ?? ''
  if (host === 'github.com') return { provider: 'github', project: match[3] }
  if (host.includes('gitlab')) return { provider: 'gitlab', project: match[3] }
  return undefined
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

  createSettings(settings, board)
  if (target.kind === 'path') linkSettings(context.cwd, context.home, settings)
  const loaded = loadConfig(settings)
  if (!loaded.ok) return loaded
  return finish(context, settings, loaded.config)
}

async function finish(context: Context, settings: string, config: Config): Promise<InitResult> {
  const warnings = await checkTools(config, context)
  await boardAdapter(context, config)
    .prepare()
    .catch((error: unknown) => warnings.push(`the board labels were not created: ${(error as Error).message}`))
  return { ok: true, settings, warnings, board: boardSteps(config) }
}

function boardSteps(config: Config): string[] {
  const labels = TASK_STATES.map((state) => STATE_LABEL + state).join(', ')
  if (config.board.provider === 'gitlab') {
    return [`Labels: ${labels}.`, 'Board: open Issues → Boards and add one list per conveyor:: label, in this order.']
  }
  if (config.board.github_project) {
    return [`Labels: ${labels}.`, `Board: in project ${config.board.github_project}, open a Board view and choose the field Conveyor under "Column by".`]
  }
  return [
    `Labels: ${labels}.`,
    'Board: create a GitHub project, set board.github_project to its number (conveyor config set board.github_project <number>), start the conveyor, then choose the field Conveyor under "Column by" in a Board view.',
  ]
}

function createSettings(dir: string, board: Board) {
  mkdirSync(dir, { recursive: true })
  for (const entry of ['stages', 'smart', 'live', 'formats', 'triage.md', 'local.yaml']) {
    cpSync(join(TEMPLATES, entry), join(dir, entry), { recursive: true })
  }
  cpSync(join(TEMPLATES, 'gitignore'), join(dir, '.gitignore'))
  const config = readFileSync(join(TEMPLATES, 'config.yaml'), 'utf8')
    .replace('{{provider}}', board.provider)
    .replace('{{project}}', JSON.stringify(board.project))
  writeFileSync(join(dir, 'config.yaml'), config)
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
