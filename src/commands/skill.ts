import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '../cli.js'

const SKILL = 'conveyor-help'
const SOURCE = fileURLToPath(new URL(`../../skills/${SKILL}/`, import.meta.url))

export function skillState(base: string): 'missing' | 'old' | 'current' {
  const targets = [join(base, '.claude', 'skills', SKILL), join(base, '.agents', 'skills', SKILL)]
  if (!targets.some((target) => existsSync(join(target, 'SKILL.md')))) return 'missing'
  const files = readdirSync(SOURCE)
  const same = (target: string) => files.every((file) => existsSync(join(target, file)) && readFileSync(join(target, file), 'utf8') === readFileSync(join(SOURCE, file), 'utf8'))
  return targets.every(same) ? 'current' : 'old'
}

export function skillInstall(context: Context, options: { project?: boolean }, json: boolean): number {
  const base = options.project ? context.cwd : context.home
  const targets = [join(base, '.claude', 'skills', SKILL), join(base, '.agents', 'skills', SKILL)]
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(SOURCE, target, { recursive: true })
  }
  context.stdout(
    json
      ? `${JSON.stringify({ skill: SKILL, installed: targets })}\n`
      : `Installed the ${SKILL} skill:\n${targets.map((target) => `  ${target}`).join('\n')}\nClaude Code reads .claude/skills; OpenCode, Pi, OpenHands, and Codex read .agents/skills.\n`,
  )
  return 0
}
