import type { Config } from '../config.js'

const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[\w-]{10,})/g
const SECRET_NAME = /TOKEN|SECRET|PASS|KEY|CREDENTIAL/i
const MIN_SECRET = 8
const LIMIT = 2000

export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value !== undefined && value.length >= MIN_SECRET)
    .map(([, value]) => value as string)
}

export function configSecrets(config: Config): string[] {
  return Object.values(config.harnesses).flatMap((harness) => secretValues(harness.env))
}

export function redactSecrets(text: string, values: string[] = []) {
  return values.reduce((clean, value) => clean.replaceAll(value, '[redacted]'), text.replace(SECRET, '[redacted]'))
}

export function publicText(text: string, home: string) {
  const clean = redactSecrets(text).replaceAll(home, '~')
  return clean.length > LIMIT ? `${clean.slice(0, LIMIT)}…` : clean
}
