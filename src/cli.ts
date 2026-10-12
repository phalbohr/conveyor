import { createRequire } from 'node:module'
import { Argument, Command, CommanderError, Option } from 'commander'
import type { Board as BoardPort } from './board/board.js'
import { configEdit, configGet, configList } from './commands/config.js'
import { hub, openSettings } from './commands/hub.js'
import { attachCommand, createTaskCommand, newCommand, writeCommand, type NewForm } from './commands/live.js'
import { modelsCommand } from './commands/models.js'
import { type ClaudeModel, type Probes } from './models.js'
import { skillInstall } from './commands/skill.js'
import { prepare, releaseCommand, resetCommand, runCommand } from './commands/run.js'
import { watchCommand } from './commands/watch.js'
import { loadConfig, type Config } from './config.js'
import { detectBoard, initProject, type Board, type InitResult, type Target } from './init.js'
import { findSettings } from './settings.js'
import { collectStatus, type StatusSnapshot } from './status.js'
import { statusLines } from './ui/status-lines.js'
import { promptInit } from './ui/init-prompt.js'
import { boardCheckCommand, boardUpdateCommand } from './commands/board.js'

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
  claudeModels?: () => Promise<ClaudeModel[]>
  boardFor?: (config: Config) => BoardPort
}

type InitOptions = { path?: string; use?: string; provider?: Board['provider']; project?: string }

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export async function main(argv: string[], context: Context): Promise<number> {
  let exitCode = 0
  const program = new Command()
    .name('conveyor')
    .description('Configurable development conveyor: coding harnesses move kanban tasks from idea to merge')
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
      if (!board && target.kind !== 'use' && context.interactive) {
        context.stdout('Initialization cancelled; nothing was created.\n')
        return
      }
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
      await openSettings(context, settings)
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
    .command('models')
    .description('models and efforts that each harness offers')
    .argument('[harness]', 'one harness; default: the harnesses your stages use')
    .option('--refresh', 'ask the harnesses again instead of using the cached list')
    .action(async (harness: string | undefined, options: { refresh?: boolean }) => {
      exitCode = await modelsCommand(context, harness, options, json())
    })

  const boardCommand = program.command('board').description('compare the board with what this version of the conveyor uses')
  boardCommand
    .command('check')
    .description('list missing labels, a missing Conveyor field or options, and tasks with labels this version does not use; changes nothing')
    .action(async () => {
      exitCode = await boardCheckCommand(context, json())
    })
  boardCommand
    .command('update')
    .description('add the missing labels and the Conveyor field; never changes or deletes existing labels, fields, or options')
    .action(async () => {
      exitCode = await boardUpdateCommand(context, json())
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
    .description('put a new task on the board: shape it in a live harness session (default), write it in your editor (--write), or give its title (--title)')
    .option('--write', 'write title, form, and text in $EDITOR')
    .option('--title <title>', 'create the task with this title, without a harness session')
    .addOption(new Option('--form <form>', 'form of the task for --title').choices(['idea', 'story', 'plan', 'draft']).default('idea'))
    .option('--body <text>', 'text of the task for --title')
    .action(async (options: { write?: boolean; title?: string; form: NewForm; body?: string }) => {
      if (options.title) exitCode = await createTaskCommand(context, { title: options.title, form: options.form, ...(options.body ? { body: options.body } : {}) }, json())
      else if (options.write) exitCode = await writeCommand(context, json())
      else exitCode = await newCommand(context, json())
    })

  program
    .command('attach')
    .description('answer the questions of a waiting task in a live harness session')
    .argument('<issue>', 'issue number on the board, for example 51')
    .action(async (issue: string) => {
      exitCode = validIssue(context, issue) ? await attachCommand(context, issue) : 1
    })

  program
    .command('release')
    .description('release the claim of a task')
    .argument('<issue>', 'issue number on the board, for example 51')
    .option('--force', 'release a task with private artifacts of another member')
    .action(async (issue: string, options: { force?: boolean }) => {
      exitCode = validIssue(context, issue) ? await releaseCommand(context, issue, options.force ?? false) : 1
    })

  program
    .command('watch')
    .description('show what the harness does in the stages of a task (needs session_logs: true)')
    .argument('<issue>', 'issue number on the board, for example 51')
    .option('-f, --follow', 'keep showing new lines until Ctrl+C')
    .action(async (issue: string, options: { follow?: boolean }) => {
      exitCode = validIssue(context, issue) ? await watchCommand(context, issue, options.follow ?? false) : 1
    })

  program
    .command('reset')
    .description('stop a task, close its pull request, delete its branch and workspace, clear its workpad, and return it to Backlog')
    .argument('<issue>', 'issue number on the board, for example 51')
    .addOption(new Option('--form <form>', 'form to start again with; default: the form the conveyor took it with').choices(['idea', 'story', 'plan', 'none']))
    .action(async (issue: string, options: { form?: 'idea' | 'story' | 'plan' | 'none' }) => {
      exitCode = validIssue(context, issue) ? await resetCommand(context, issue, options.form) : 1
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
    if (!answers) {
      context.stdout('Initialization cancelled; nothing was created.\n')
      return 0
    }
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
  if (context.interactive && !json) return hub(context, prepared)

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
    context.stdout(`${JSON.stringify(result.ok ? { settings: result.settings, warnings: result.warnings, board: result.board } : { errors: result.errors })}\n`)
    return result.ok ? 0 : 1
  }
  if (!result.ok) {
    context.stderr(`${result.errors.join('\n')}\n`)
    return 1
  }
  context.stdout(`Settings: ${result.settings}\n${result.board.join('\n')}\n`)
  for (const warning of result.warnings) context.stderr(`warning: ${warning}\n`)
  return 0
}

function validIssue(context: Context, issue: string) {
  if (/^\d+$/.test(issue)) return true
  context.stderr(`${issue} is not an issue number; use the bare number, for example 51\n`)
  return false
}

export function probesOf(context: Context): Probes {
  return { run: context.run, ...(context.claudeModels ? { claudeModels: context.claudeModels } : {}) }
}
