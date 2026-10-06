const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[\w-]{10,})/g
const LIMIT = 2000

export function publicText(text: string, home: string) {
  const clean = text.replace(SECRET, '[redacted]').replaceAll(home, '~')
  return clean.length > LIMIT ? `${clean.slice(0, LIMIT)}…` : clean
}
