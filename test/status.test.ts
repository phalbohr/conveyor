import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeBoard } from '../src/board/fake.js'
import { quotaFile, usageFile } from '../src/commands/run.js'
import { loadConfig } from '../src/config.js'
import { agentComment, renderWorkpad } from '../src/engine/workpad.js'
import { collectStatus } from '../src/status.js'
import { QuotaStore, UsageLedger } from '../src/usage.js'
import { tempDir } from './helpers.js'

async function board() {
  const fake = new FakeBoard('me')
  const claim = async (title: string, state: Parameters<FakeBoard['setState']>[1], owner = 'me') => {
    const task = await fake.createTask(title, 'body', { state })
    await fake.setOwner(task.id, owner)
    return task.id
  }
  const working = await claim('Working', 'in-progress')
  await fake.addComment(working, renderWorkpad({ stage: 'implement', attempt: 2, lastError: 'tests are red', retryAt: '2026-10-05T12:00:00.000Z' }, ''))
  const waiting = await claim('Waiting', 'needs-input')
  const question = await fake.addComment(waiting, agentComment('questions', 'Which database?'))
  await fake.addComment(waiting, renderWorkpad({ attempt: 0, waiting: { kind: 'questions', stage: 'plan', commentId: question.id, since: '2026-10-05T09:00:00.000Z' } }, ''))
  const answered = await claim('Answered', 'needs-input')
  const asked = await fake.addComment(answered, agentComment('questions', 'Which color?'))
  await fake.addComment(answered, renderWorkpad({ attempt: 0, waiting: { kind: 'questions', stage: 'plan', commentId: asked.id, since: '2026-10-05T09:00:00.000Z' } }, ''))
  await fake.addComment(answered, 'Blue.')
  const review = await claim('Review', 'review')
  await fake.openPullRequest(review)
  await fake.createTask('Open plan', 'body', { form: 'plan' })
  await fake.createTask('Open idea', 'body', { form: 'idea' })
  await claim('Theirs', 'in-progress', 'alice')
  return fake
}

describe('collectStatus', () => {
  it('summarizes my tasks, the team queue, and my limits', async () => {
    const settings = tempDir('conveyor-settings-')
    writeFileSync(join(settings, 'config.yaml'), 'board: {provider: github, project: acme/app}\n')
    writeFileSync(join(settings, 'local.yaml'), 'limits: {running: 3, awaiting_me: 5, awaiting_review: 2, daily_tokens: 1000000, subscription: {five_hour_reserve: 10}}\n')
    const loaded = loadConfig(settings)
    if (!loaded.ok) throw new Error(loaded.errors.join('\n'))
    const home = tempDir('conveyor-home-')
    new UsageLedger(usageFile(home, 'acme/app')).add(1234)
    new QuotaStore(quotaFile(home, 'acme/app')).set('claude', { fiveHour: { utilization: 0.42, resetsAt: '2026-10-05T14:00:00.000Z' } }, 1_000)
    mkdirSync(join(home, '.conveyor', 'run'), { recursive: true })
    writeFileSync(join(home, '.conveyor', 'run', 'acme-app.pid'), String(process.pid))

    const status = await collectStatus({ board: await board(), config: loaded.config, settings, home })

    expect(status).toMatchObject({ project: 'acme/app', me: 'me', runner: { running: true, pid: process.pid } })
    expect(status.mine.map((task) => [task.title, task.state])).toEqual([
      ['Working', 'in-progress'],
      ['Waiting', 'needs-input'],
      ['Answered', 'needs-input'],
      ['Review', 'review'],
    ])
    expect(status.mine[0]).toMatchObject({ stage: 'implement', attempt: 2, lastError: 'tests are red', retryAt: '2026-10-05T12:00:00.000Z' })
    expect(status.mine[1]).toMatchObject({ stage: 'plan', answered: false, waitingSince: '2026-10-05T09:00:00.000Z' })
    expect(status.mine[2]).toMatchObject({ answered: true })
    expect(status.mine[3]?.pullRequest).toContain('https://')
    expect(status.team).toEqual({ unclaimed: 2, claimedByOthers: 1 })
    expect(status.limits).toMatchObject({
      running: { used: 1, limit: 3 },
      awaitingMe: { used: 1, limit: 5 },
      awaitingReview: { used: 1, limit: 2 },
      dailyTokens: { used: 1234, limit: 1000000 },
    })
    expect(status.limits.subscription.claude).toMatchObject({ fiveHour: { utilization: 0.42 }, fiveHourReserve: 10 })
  })

  it('reports a stopped runner', async () => {
    const settings = tempDir()
    writeFileSync(join(settings, 'config.yaml'), 'board: {provider: github, project: acme/app}\n')
    const loaded = loadConfig(settings)
    if (!loaded.ok) throw new Error('invalid')
    const status = await collectStatus({ board: new FakeBoard('me'), config: loaded.config, settings, home: tempDir() })
    expect(status.runner).toEqual({ running: false })
    expect(status.mine).toEqual([])
  })
})
