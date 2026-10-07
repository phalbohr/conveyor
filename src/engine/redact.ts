const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[\w-]{10,})/g
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY/i
const MIN_SECRET = 12
const LIMIT = 2000

export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value !== undefined && value.length >= MIN_SECRET)
    .map(([, value]) => value as string)
}

export function redactSecrets(text: string, values: string[] = []) {
  return values.reduce((clean, value) => clean.replaceAll(value, '[redacted]'), text.replace(SECRET, '[redacted]'))
}

export function publicText(text: string, home: string) {
  const clean = redactSecrets(text).replaceAll(home, '~')
  return clean.length > LIMIT ? `${clean.slice(0, LIMIT)}…` : clean
}
