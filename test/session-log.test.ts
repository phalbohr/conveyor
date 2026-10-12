import { statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeEvent, readSession, removeSession, sessionFile, sessionWriter } from '../src/session-log.js'
import { runCli, tempDir } from './helpers.js'

const cwd = '/work/7'
const json = (value: unknown) => JSON.stringify(value)

describe('describeEvent', () => {
  it('reads claude stream-json', () => {
    expect(describeEvent(json({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' }))).toEqual(['● session started · claude-sonnet-5-5'])
    expect(describeEvent(json({ type: 'system', subtype: 'hook_started' }))).toEqual([])
    expect(
      describeEvent(
        json({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'Read', input: { file_path: '/work/7/src/a.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test\n--silent' } }] } }),
        cwd,
      ),
    ).toEqual(['▸ Read src/a.ts', '▸ Bash npm test'])
    expect(describeEvent(json({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\n\nAll green.' }] } }))).toEqual(['Done.', 'All green.'])
    expect(describeEvent(json({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }, { type: 'tool_result', is_error: true, content: 'Exit code 1\nmore' }] } }))).toEqual(['  ✗ Exit code 1'])
    expect(describeEvent(json({ type: 'result', is_error: false }))).toEqual(['■ finished'])
  })

  it('reads codex exec --json', () => {
    expect(describeEvent(json({ type: 'item.started', item: { type: 'command_execution', command: "/bin/zsh -lc 'cat a.txt'" } }))).toEqual(['▸ $ cat a.txt'])
    expect(describeEvent(json({ type: 'item.started', item: { type: 'command_execution', command: '/bin/zsh -lc ls' } }))).toEqual(['▸ $ ls'])
    expect(describeEvent(json({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }))).toEqual([])
    expect(describeEvent(json({ type: 'item.completed', item: { type: 'command_execution', exit_code: 2 } }))).toEqual(['  ✗ exit 2'])
    expect(describeEvent(json({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/work/7/b.txt', kind: 'add' }] } }), cwd)).toEqual(['▸ add b.txt'])
    expect(describeEvent(json({ type: 'item.completed', item: { type: 'agent_message', text: 'I ran ls.' } }))).toEqual(['I ran ls.'])
    expect(describeEvent(json({ type: 'turn.failed', error: { message: 'quota' } }))).toEqual(['✗ quota'])
  })

  it('reads opencode and kilo --format json', () => {
    expect(describeEvent(json({ type: 'tool_use', part: { tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } } }))).toEqual(['▸ bash ls'])
    expect(describeEvent(json({ type: 'tool_use', part: { tool: 'write', state: { status: 'error', input: { filePath: '/work/7/b.txt' }, error: 'denied' } } }), cwd)).toEqual(['▸ write b.txt', '  ✗ denied'])
    expect(describeEvent(json({ type: 'text', part: { text: 'b.txt now says bye.' } }))).toEqual(['b.txt now says bye.'])
    expect(describeEvent(json({ type: 'step_finish', part: { reason: 'length' } }))).toEqual(['✗ the model reached its length limit'])
    expect(describeEvent(json({ type: 'error', error: { name: 'APIError', data: { message: 'No api key passed in.' } } }))).toEqual(['✗ No api key passed in.'])
  })

  it('keeps plain text, shortens long text, and skips unknown events', () => {
    expect(describeEvent('compiling…')).toEqual(['compiling…'])
    expect(describeEvent(json({ type: 'turn.started' }))).toEqual([])
    const long = describeEvent(json({ type: 'text', part: { text: Array.from({ length: 9 }, (_, index) => `line ${index}`).join('\n') } }))
    expect(long).toHaveLength(7)
    expect(long.at(-1)).toBe('… 3 more lines')
    expect(describeEvent('x'.repeat(500))[0]).toHaveLength(240)
  })
})

describe('session file', () => {
  it('writes readable, redacted lines that only the user can read, and removes them', () => {
    const home = tempDir('conveyor-home-')
    const file = sessionFile(home, 'acme/app', '7')
    expect(file).toBe(join(home, '.conveyor', 'sessions', 'acme-app', '7.log'))
    const writer = sessionWriter(file, cwd, (text) => text.replaceAll('sk-secret', '[redacted]'))
    writer.header('implement · claude · attempt 1')
    writer.event(json({ type: 'tool_use', part: { tool: 'bash', state: { input: { command: 'curl -H sk-secret' } } } }))
    writer.event(json({ type: 'text', part: { text: 'one\ntwo' } }))
    const lines = readSession(file)
    expect(lines.map((line) => line.slice(9))).toEqual(['── implement · claude · attempt 1 ──', '▸ bash curl -H [redacted]', 'one', 'two'])
    expect(lines[3]?.startsWith('         ')).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    removeSession(file)
    expect(readSession(file)).toEqual([])
  })
})

describe('conveyor watch', () => {
  it('prints the session of a task, or says how to turn the logs on', async () => {
    const init = await runCli(['init', '--provider', 'github', '--project', 'acme/app'])
    const options = { cwd: init.context.cwd, home: init.context.home }

    const off = await runCli(['watch', '7'], options)
    expect(off.code).toBe(1)
    expect(off.stderr).toContain('conveyor config set session_logs true')

    expect((await runCli(['config', 'set', 'session_logs', 'true'], options)).code).toBe(0)
    const empty = await runCli(['watch', '7'], options)
    expect(empty.stdout).toContain('Nothing recorded yet for #7')

    sessionWriter(sessionFile(init.context.home, 'acme/app', '7'), cwd, (text) => text).event(json({ type: 'text', part: { text: 'hello' } }))
    const shown = await runCli(['watch', '7'], options)
    expect(shown.code).toBe(0)
    expect(shown.stdout).toMatch(/^\d\d:\d\d:\d\d hello\n$/)
  })
})
