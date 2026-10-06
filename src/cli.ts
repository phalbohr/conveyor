import { createRequire } from 'node:module'
import { Argument, Command, CommanderError, Option } from 'commander'
import type { Board as BoardPort } from './board/board.js'
import { configEdit, configGet, configList } from './commands/config.js'
import { attachCommand, newCommand } from './commands/live.js'
import { skillInstall } from './commands/skill.js'
import { prepare, releaseCommand, runCommand } from './commands/run.js'
import { loadConfig, type Config } from './config.js'
import { detectBoard, initProject, type Board, type InitResult, type Target } from './init.js'
import { findSettings } from './settings.js'
import { collectStatus, type StatusSnapshot } from './status.js'
import { statusLines } from './ui/status-lines.js'
import { SettingsDocument } from './settings-editor.js'
import { showSettings } from './ui/settings-screen.js'
import { showStatus } from './ui/status-screen.js'
import { promptInit } from './ui/init-prompt.js'

export type Run = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export type Interact = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>

export type Context = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  cwd: string
  home: string
  interactive: boolean
  run: Run
  interact: Interact
  boardFor?: (config: Config) => BoardPort
}

type InitOptions = { path?: string; use?: string; provider?: Board['provider']; project?: string }

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export async function main(argv: string[], context: Context): Promise<number> {
  let exitCode = 0
  const program = new Command()
    .name('conveyor')
    .description('Configurable development conveyor: agents move kanban tasks from idea to merge')
    .option('--json', 'machine-readable output')
    .option('-V, --version', 'print the version')
    .exitOverride()
    .configureOutput({ writeOut: context.stdout, writeErr: context.stderr })

  const json = () => Boolean(program.opts().json)

  program.action(async (options: { version?: boolean }) => {
    if (options.version) {
      context.stdout(json() ? `${JSON.stringify({ version })}\n` : `${version}\n`)
      return
    }
    exitCode = await status(context, json())
  })

  program
    .command('init')
    .description('create conveyor settings or link existing settings')
    .addOption(new Option('--path <dir>', 'create the settings in this directory').conflicts('use'))
    .option('--use <dir>', 'link existing settings')
    .addOption(new Option('--provider <provider>', 'board provider').choices(['github', 'gitlab']))
    .option('--project <project>', 'board project, for example owner/repo')
    .action(async (options: InitOptions) => {
      const target: Target = options.use
        ? { kind: 'use', path: options.use }
        : options.path
          ? { kind: 'path', path: options.path }
          : { kind: 'here' }
      const board = target.kind === 'use' ? undefined : await resolveBoard(context, options)
      exitCode = report(context, await initProject(context, target, board), json())
    })

  program
    .command('run')
    .description('work the board: claim tasks within the limits and run their stages')
    .option('--once', 'run one cycle, wait for the started stages, and exit')
    .action(async (options: { once?: boolean }) => {
      exitCode = await runCommand(context, options)
    })

  program
    .command('settings')
    .description('edit the team and personal settings')
    .action(async () => {
      const settings = findSettings(context.cwd, context.home)
      if (!settings) {
        context.stderr(`No conveyor settings found in ${context.cwd}. Run \`conveyor init\`.\n`)
        exitCode = 1
        return
      }
      if (!context.interactive) {
        context.stderr(`The settings editor needs a terminal. Edit ${settings}/config.yaml and local.yaml directly.\n`)
        exitCode = 1
        return
      }
      await showSettings(new SettingsDocument(settings))
    })

  const config = program.command('config').description('read and change settings from scripts and agents')
  config
    .command('list')
    .description('all settings with value, options, and a short description')
    .action(() => {
      exitCode = configList(context, json())
    })
  config
    .command('get')
    .argument('<key>', 'setting key, for example transitions.merge')
    .action((key: string) => {
      exitCode = configGet(context, key, json())
    })
  config
    .command('set')
    .argument('<key>', 'setting key, for example stages.review.model')
    .argument('<value>', 'new value; an empty string makes a stage value inherit from defaults')
    .action((key: string, value: string) => {
      exitCode = configEdit(context, (doc) => {
        doc.set(key, value)
        return `Saved ${key} = ${value || '(inherit)'}`
      })
    })
  const stage = config.command('stage').description('add, remove, or move stages')
  stage
    .command('add')
    .argument('<name>', 'stage name: lowercase letters, digits, hyphens')
    .option('--after-merge', 'run the stage after merge')
    .addOption(new Option('--when <when>', 'condition for a stage after merge').choices(['success', 'failure', 'always']).default('success'))
    .action((name: string, options: { afterMerge?: boolean; when: 'success' | 'failure' | 'always' }) => {
      exitCode = configEdit(context, (doc) => {
        doc.addStage(name, options.afterMerge ? 'after-merge' : 'before-merge', options.afterMerge ? options.when : undefined)
        return `Added stage ${name}. Write its instructions in stages/${name}.md.`
      })
    })
  stage
    .command('remove')
    .argument('<name>', 'stage name')
    .action((name: string) => {
      exitCode = configEdit(context, (doc) => {
        doc.removeStage(name)
        return `Removed stage ${name}.`
      })
    })
  stage
    .command('move')
    .argument('<name>', 'stage name')
    .addArgument(new Argument('<direction>', 'up or down').choices(['up', 'down']))
    .action((name: string, direction: 'up' | 'down') => {
      exitCode = configEdit(context, (doc) => {
        doc.moveStage(name, direction === 'up' ? -1 : 1)
        return `Stages: ${doc.stageNames().join(' → ')}`
      })
    })

  program
    .command('skill')
    .description('install agent skills')
    .command('install')
    .description('install the conveyor-help skill for Claude Code and agents that read .agents/skills')
    .option('--project', 'install into this repository instead of your home directory')
    .action((options: { project?: boolean }) => {
      exitCode = skillInstall(context, options, json())
    })

  program
    .command('new')
    .description('shape a new task in a live session with an agent and put it on the board')
    .action(async () => {
      exitCode = await newCommand(context, json())
    })

  program
    .command('attach')
    .description('answer the questions of a waiting task in a live session with an agent')
    .argument('<issue>', 'issue number on the board, for example 51')
    .action(async (issue: string) => {
      exitCode = await attachCommand(context, issue)
    })

  program
    .command('release')
    .description('release the claim of a task')
    .argument('<issue>', 'issue number on the board, for example 51')
    .option('--force', 'release a task with private artifacts of another member')
    .action(async (issue: string, options: { force?: boolean }) => {
      exitCode = await releaseCommand(context, issue, options.force ?? false)
    })

  try {
    await program.parseAsync(argv, { from: 'user' })
    return exitCode
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode
    throw error
  }
}

async function status(context: Context, json: boolean): Promise<number> {
  const settings = findSettings(context.cwd, context.home)
  if (!settings) {
    if (!context.interactive) {
      context.stderr(`No conveyor settings found in ${context.cwd}. Run \`conveyor init\`.\n`)
      return 1
    }
    const answers = await promptInit({ askTarget: true, detected: await detectBoard(context) })
    if (!answers) return 1
    return report(context, await initProject(context, answers.target, answers.board), json)
  }

  const loaded = loadConfig(settings)
  if (!loaded.ok) {
    if (json) context.stdout(`${JSON.stringify({ settings, valid: false, errors: loaded.errors })}\n`)
    else context.stderr(`Settings: ${settings}\n${loaded.errors.join('\n')}\n`)
    return 1
  }
  const prepared = prepare(context)
  if (!prepared) return 1
  const load = async () => {
    const current = loadConfig(settings)
    if (!current.ok) throw new Error(current.errors.join('; '))
    return collectStatus({ board: prepared.board, config: current.config, settings, home: context.home })
  }
  if (context.interactive && !json) {
    while ((await showStatus(load)) === 'settings') await showSettings(new SettingsDocument(settings))
    return 0
  }

  let status: StatusSnapshot | undefined
  let boardError: string | undefined
  try {
    status = await load()
  } catch (error) {
    boardError = (error as Error).message
  }
  if (json) {
    context.stdout(`${JSON.stringify({ settings, valid: true, ...(status ? { status } : { boardError }) })}\n`)
    return 0
  }
  context.stdout(`Settings: ${settings}\nConfiguration is valid.\n`)
  if (status) context.stdout(`\n${statusLines(status).map((line) => line.text).join('\n')}\n`)
  else context.stderr(`Board error: ${boardError}\n`)
  return 0
}

async function resolveBoard(context: Context, options: InitOptions): Promise<Board | undefined> {
  const detected = options.provider && options.project ? {} : await detectBoard(context)
  const provider = options.provider ?? detected.provider
  const project = options.project ?? detected.project
  if (provider && project) return { provider, project }
  if (!context.interactive) return undefined
  return (await promptInit({ askTarget: false, detected: { provider, project } }))?.board
}

function report(context: Context, result: InitResult, json: boolean): number {
  if (json) {
    context.stdout(`${JSON.stringify(result.ok ? { settings: result.settings, warnings: result.warnings } : { errors: result.errors })}\n`)
    return result.ok ? 0 : 1
  }
  if (!result.ok) {
    context.stderr(`${result.errors.join('\n')}\n`)
    return 1
  }
  context.stdout(`Settings: ${result.settings}\n`)
  for (const warning of result.warnings) context.stderr(`warning: ${warning}\n`)
  return 0
}
