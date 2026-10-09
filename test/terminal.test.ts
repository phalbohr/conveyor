import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { clearOnShrink } from '../src/ui/terminal.js'

function fakeStdout(columns: number) {
  const writes: string[] = []
  const stream = Object.assign(new EventEmitter(), { columns, write: (text: string) => writes.push(text) > 0 })
  return { stream: stream as unknown as NodeJS.WriteStream & { columns: number }, writes }
}

describe('clearOnShrink', () => {
  it('clears the screen before the renderer when the terminal gets narrower', () => {
    const { stream, writes } = fakeStdout(120)
    const order: string[] = []
    stream.on('resize', () => order.push('renderer'))
    const restore = clearOnShrink(stream)
    stream.on('resize', () => order.push('later'))
    stream.write = ((text: string) => {
      order.push('clear')
      return writes.push(text) > 0
    }) as typeof stream.write

    stream.columns = 60
    stream.emit('resize')
    expect(order).toEqual(['clear', 'renderer', 'later'])
    expect(writes).toEqual(['\u001B[2J\u001B[H'])

    stream.columns = 100
    stream.emit('resize')
    expect(writes).toHaveLength(1)

    restore()
    stream.columns = 40
    stream.emit('resize')
    expect(writes).toHaveLength(1)
  })
})
