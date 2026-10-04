#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { main } from './cli.js'
import { createRun } from './run.js'

const cwd = process.cwd()

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd,
  home: homedir(),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  run: createRun(cwd),
  interact: (command, args, options) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' })
      child.on('error', () => resolve(127))
      child.on('close', (code) => resolve(code ?? 1))
    }),
})
