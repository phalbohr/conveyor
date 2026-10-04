import { createRequire } from 'node:module'
import { Command, CommanderError, Option } from 'commander'
import { loadConfig } from './config.js'
import { detectBoard, initProject, type Board, type InitResult, type Target } from './init.js'
import { findSettings } from './settings.js'
import { promptInit } from './ui/init-prompt.js'

export type Context = {
  stdout: (text: string) => void
  stderr: (text: string) => void
  cwd: string
  home: string
  interactive: boolean
  run: (command: string, args: string[]) => Promise<{ code: number; stdout: string }>
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
  if (json) {
    context.stdout(`${JSON.stringify(loaded.ok ? { settings, valid: true } : { settings, valid: false, errors: loaded.errors })}\n`)
  } else if (loaded.ok) {
    context.stdout(`Settings: ${settings}\nConfiguration is valid.\n`)
  } else {
    context.stderr(`Settings: ${settings}\n${loaded.errors.join('\n')}\n`)
  }
  return loaded.ok ? 0 : 1
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
