import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InitPrompt } from '../src/ui/init-prompt.js'

const ENTER = '\r'
const DOWN = '\u001B[B'

type Rendered = { stdin: { write: (data: string) => void }; lastFrame: () => string | undefined }

async function press({ stdin, lastFrame }: Rendered, ...keys: string[]) {
  for (const [index, key] of keys.entries()) {
    const before = lastFrame()
    stdin.write(key)
    if (index < keys.length - 1) await vi.waitFor(() => expect(lastFrame()).not.toBe(before))
  }
}

describe('InitPrompt', () => {
  it('initializes in the current directory with the detected board', async () => {
    const onDone = vi.fn()
    const rendered = render(<InitPrompt askTarget detected={{ provider: 'gitlab', project: 'acme/widgets' }} onDone={onDone} />)
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain('Use existing settings'))

    await press(rendered, ENTER, ENTER, ENTER)

    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({ target: { kind: 'here' }, board: { provider: 'gitlab', project: 'acme/widgets' } }),
    )
  })

  it('links existing settings by path', async () => {
    const onDone = vi.fn()
    const rendered = render(<InitPrompt askTarget detected={{}} onDone={onDone} />)
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain('Use existing settings'))

    await press(rendered, DOWN, DOWN, ENTER, '/settings', ENTER)

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith({ target: { kind: 'use', path: '/settings' } }))
  })

  it('asks only for the board when the target is known', async () => {
    const onDone = vi.fn()
    const rendered = render(<InitPrompt askTarget={false} detected={{}} onDone={onDone} />)
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain('Board provider'))

    await press(rendered, ENTER, 'acme/tools', ENTER)

    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({ target: { kind: 'here' }, board: { provider: 'github', project: 'acme/tools' } }),
    )
  })
})
