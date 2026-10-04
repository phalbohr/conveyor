#!/usr/bin/env node
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
})
