#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { main } from './cli.js'

const cwd = process.cwd()

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd,
  home: homedir(),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { cwd }, (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0
        resolve({ code, stdout })
      })
    }),
})
