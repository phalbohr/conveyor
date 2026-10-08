import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { RedactingBoard } from '../src/board/redacting.js'
import { secretValues } from '../src/engine/redact.js'

describe('RedactingBoard', () => {
  const token = `ghp_${'c'.repeat(36)}`
  const key = 'local-model-key-123456'
  const setup = () => {
    const fake = new FakeBoard('me')
    return { fake, board: new RedactingBoard(fake, () => secretValues({ LLM_API_KEY: key, HOME: '/Users/me', SHORT_TOKEN: 'abc' })) }
  }

  it('hides token patterns and secret environment values in everything it writes', async () => {
    const { fake, board } = setup()
    const task = await board.createTask(`Task ${token}`, `uses ${key}`, { form: 'plan' })
    await board.updateBody(task.id, `${'long story '.repeat(500)}${token}`)
    const comment = await board.addComment(task.id, `artifact with ${key}`)
    await board.updateComment(comment.id, `question about ${token}`)
    const pull = await board.openPullRequest(task.id, `PR ${token}`, `body ${key}`)

    const written = [(await fake.getTask(task.id))?.title, (await fake.getTask(task.id))?.body, ...(await fake.listComments(task.id)).map((c) => c.body)].join('\n')
    expect(written).not.toContain(token)
    expect(written).not.toContain(key)
    expect(written).toContain('[redacted]')
    expect((await fake.getTask(task.id))?.body.length).toBeGreaterThan(5000)
    expect(pull.state).toBe('open')
  })

  it('treats values of eight or more characters of secret-named variables as secrets', () => {
    expect(secretValues({ LLM_API_KEY: key, DB_PASSWORD: 'hunter22', HOME: '/Users/me/a/long/path', SHORT_TOKEN: 'abc', SERVICE_KEY: 'k3y-value' })).toEqual([key, 'hunter22', 'k3y-value'])
  })
})
