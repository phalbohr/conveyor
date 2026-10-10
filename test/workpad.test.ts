import { describe, expect, it } from 'vitest'
import { findWorkpad, renderWorkpad } from '../src/engine/workpad.js'

describe('workpad', () => {
  it('keeps colored harness errors out of the hidden state', () => {
    const body = renderWorkpad({ attempt: 1, stage: 'plan', lastError: 'no result file: \x1b[91m\x1b[1mError: \x1b[0m{\n  "name": "UnknownError"\x07\n}' }, '')

    expect(body).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/)
    expect(body).not.toContain('\\u00')
    const pad = findWorkpad([{ id: '1', author: 'me', body, createdAt: '2026-10-10T00:00:00.000Z' }])
    expect(pad?.state).toMatchObject({ stage: 'plan', attempt: 1, lastError: 'no result file: Error: {\n  "name": "UnknownError"\n}' })
  })
})
