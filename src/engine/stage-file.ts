import { Liquid } from 'liquidjs'
import { parse } from 'yaml'
import { z } from 'zod'

export type StageFile = { ok: true; skills: string[]; template: string } | { ok: false; error: string }

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/
const frontmatter = z.strictObject({ skills: z.array(z.string().min(1)).default([]) })
const liquid = new Liquid({ strictVariables: true, strictFilters: true, lenientIf: true })

export function parseStageFile(text: string): StageFile {
  const match = text.match(FRONTMATTER)
  if (!match) return { ok: true, skills: [], template: text }
  let data: unknown
  try {
    data = parse(match[1] ?? '') ?? {}
  } catch (error) {
    return { ok: false, error: `invalid frontmatter: ${(error as Error).message}` }
  }
  const result = frontmatter.safeParse(data)
  if (!result.success) {
    return { ok: false, error: `invalid frontmatter: ${result.error.issues.map((issue) => `${issue.path.join('.') || 'keys'}: ${issue.message}`).join('; ')}` }
  }
  return { ok: true, skills: result.data.skills, template: text.slice(match[0].length) }
}

export function renderInstructions(template: string, variables: Record<string, unknown>): { ok: true; text: string } | { ok: false; error: string } {
  try {
    return { ok: true, text: liquid.parseAndRenderSync(template, variables) }
  } catch (error) {
    return { ok: false, error: (error as Error).message.split('\n')[0] ?? 'template error' }
  }
}
