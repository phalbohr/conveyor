import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { plain } from './engine/workpad.js'

const TEXT_LINES = 6
const LINE_WIDTH = 240

type Json = Record<string, unknown>

export function sessionFile(home: string, project: string, id: string) {
  return join(home, '.conveyor', 'sessions', project.replaceAll('/', '-'), `${id}.log`)
}

export function readSession(file: string) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

export function removeSession(file: string) {
  rmSync(file, { force: true })
}

export function sessionWriter(file: string, cwd: string, redact: (text: string) => string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const write = (lines: string[]) => {
    if (lines.length === 0) return
    const time = new Date().toTimeString().slice(0, 8)
    appendFileSync(file, lines.map((line, index) => `${index === 0 ? time : '        '} ${redact(line)}\n`).join(''), { mode: 0o600 })
  }
  return {
    header: (text: string) => write([`── ${text} ──`]),
    event: (line: string) => write(describeEvent(line, cwd)),
  }
}

export function describeEvent(line: string, cwd = ''): string[] {
  return describe(line, cwd).map(plain)
}

function describe(line: string, cwd: string): string[] {
  let event: Json
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return [clip(line)]
    event = parsed as Json
  } catch {
    return line.trim() ? [clip(line)] : []
  }
  const short = (path: unknown) => (typeof path === 'string' && cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
  const tool = (name: unknown, input: unknown) => `▸ ${String(name)}${summary(input, short)}`
  const item = event.item as Json | undefined
  const part = event.part as Json | undefined

  switch (event.type) {
    case 'system':
      return event.subtype === 'init' ? [`● session started${typeof event.model === 'string' ? ` · ${event.model}` : ''}`] : []
    case 'assistant':
      return contents(event).flatMap((content) => (content.type === 'text' ? text(content.text) : content.type === 'tool_use' ? [tool(content.name, content.input)] : []))
    case 'user':
      return contents(event).flatMap((content) => (content.type === 'tool_result' && content.is_error ? [`  ✗ ${firstLine(content.content)}`] : []))
    case 'result':
      return [event.is_error ? `■ failed: ${firstLine(event.result)}` : '■ finished']
    case 'item.started':
      return item?.type === 'command_execution' ? [`▸ $ ${unwrap(item.command)}`] : []
    case 'item.completed':
      if (item?.type === 'agent_message') return text(item.text)
      if (item?.type === 'command_execution') return typeof item.exit_code === 'number' && item.exit_code !== 0 ? [`  ✗ exit ${item.exit_code}`] : []
      if (item?.type === 'file_change' && Array.isArray(item.changes)) return item.changes.map((change: Json) => `▸ ${String(change.kind ?? 'edit')} ${String(short(change.path))}`)
      if (item?.type === 'mcp_tool_call') return [`▸ ${String(item.server)}.${String(item.tool)}`]
      if (item?.type === 'web_search') return [`▸ search ${String(item.query)}`]
      return []
    case 'turn.failed':
      return [`✗ ${firstLine((event.error as Json | undefined)?.message)}`]
    case 'tool_use': {
      const state = (part?.state ?? {}) as Json
      return [tool(part?.tool, state.input), ...(state.status === 'error' ? [`  ✗ ${firstLine(state.error)}`] : [])]
    }
    case 'text':
      return text(part?.text ?? event.text)
    case 'step_finish':
      return part?.reason === 'length' ? ['✗ the model reached its length limit'] : []
    case 'error': {
      const error = event.error as Json | undefined
      return [`✗ ${firstLine((error?.data as Json | undefined)?.message ?? error?.message ?? event.message)}`]
    }
    default:
      return []
  }
}

function contents(event: Json): Json[] {
  const content = (event.message as Json | undefined)?.content
  return Array.isArray(content) ? content : []
}

function summary(input: unknown, short: (path: unknown) => unknown) {
  if (!input || typeof input !== 'object') return ''
  const value = input as Json
  for (const key of ['command', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    if (typeof value[key] === 'string') return ` ${clip(String(key.toLowerCase().includes('path') ? short(value[key]) : value[key]).split('\n')[0] ?? '')}`
  }
  return ` ${clip(JSON.stringify(input))}`
}

function text(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return []
  const lines = value.trim().split('\n').filter((line) => line.trim())
  return [...lines.slice(0, TEXT_LINES).map(clip), ...(lines.length > TEXT_LINES ? [`… ${lines.length - TEXT_LINES} more lines`] : [])]
}

function firstLine(value: unknown) {
  return clip(String(value ?? 'error').trim().split('\n')[0] ?? '')
}

function unwrap(command: unknown) {
  const match = /^\S*sh -l?c (['"])([\s\S]*)\1$/.exec(String(command)) ?? /^\S*sh -l?c (\S+)$/.exec(String(command))
  return clip((match ? (match[2] ?? match[1] ?? '') : String(command)).split('\n')[0] ?? '')
}

function clip(line: string) {
  const text = plain(line)
  return text.length > LINE_WIDTH ? `${text.slice(0, LINE_WIDTH - 1).replace(/[^\s"'`,;:=()[\]{}<>|]*$/, '')}…` : text
}
