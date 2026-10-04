import { createRequire } from 'node:module'
import { Command, CommanderError } from 'commander'

export type Io = {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export async function main(argv: string[], io: Io): Promise<number> {
  const program = new Command()
    .name('conveyor')
    .description('Configurable development conveyor: agents move kanban tasks from idea to merge')
    .option('--json', 'machine-readable output')
    .option('-V, --version', 'print the version')
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .action((options: { json?: boolean; version?: boolean }) => {
      if (options.version) {
        io.stdout(options.json ? `${JSON.stringify({ version })}\n` : `${version}\n`)
        return
      }
      program.outputHelp()
    })

  try {
    await program.parseAsync(argv, { from: 'user' })
    return 0
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode
    throw error
  }
}
