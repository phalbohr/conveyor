import { describe, expect, it } from 'vitest'
import { GitLabBoard } from '../src/board/gitlab.js'
import type { Run } from '../src/cli.js'

const note = (id: number, username: string, body: string, system: boolean, at: string) => ({ id, body, system, author: { username }, created_at: at, updated_at: at })

function gitlab(notes: ReturnType<typeof note>[], approvers: string[]) {
  const responses: [RegExp, unknown][] = [
    [/merge_requests\?source_branch=/, [{ iid: 7 }]],
    [/merge_requests\/7$/, { iid: 7, web_url: 'https://gitlab.test/mr/7', sha: 'b'.repeat(40), state: 'opened', detailed_merge_status: 'mergeable', head_pipeline: null }],
    [/merge_requests\/7\/approvals$/, { approved_by: approvers.map((username) => ({ user: { username } })) }],
    [/merge_requests\/7\/reviewers$/, []],
    [/merge_requests\/7\/notes\?.*page=1$/, notes],
    [/merge_requests\/7\/notes\?/, []],
  ]
  const run: Run = async (_command, args) => {
    const path = args[1] ?? ''
    const match = responses.find(([pattern]) => pattern.test(path))
    return { code: 0, stdout: JSON.stringify(match?.[1] ?? {}), stderr: '' }
  }
  return new GitLabBoard('group/project', run, { retryDelay: 0 })
}

describe('GitLab merge request approvals', () => {
  it('dates an approval by its system note and drops approvals without one', async () => {
    const board = gitlab(
      [note(1, 'alice', 'approved this merge request', true, '2026-10-01T10:00:00.000Z'), note(2, 'carol', 'Looks fine', false, '2026-10-01T11:00:00.000Z')],
      ['alice', 'bob'],
    )
    const pull = await board.pullRequest('3')
    expect(pull?.headSha).toBe('b'.repeat(40))
    expect(pull?.reviews).toEqual([{ author: 'alice', state: 'approved', body: '', submittedAt: '2026-10-01T10:00:00.000Z' }])
    expect(pull?.comments).toEqual([{ author: 'carol', body: 'Looks fine', createdAt: '2026-10-01T11:00:00.000Z' }])
  })

  it('takes the latest approval note of a user', async () => {
    const board = gitlab(
      [
        note(1, 'alice', 'approved this merge request', true, '2026-10-01T10:00:00.000Z'),
        note(2, 'alice', 'unapproved this merge request', true, '2026-10-02T10:00:00.000Z'),
        note(3, 'alice', 'approved this merge request', true, '2026-10-03T10:00:00.000Z'),
      ],
      ['alice'],
    )
    expect((await board.pullRequest('3'))?.reviews[0]?.submittedAt).toBe('2026-10-03T10:00:00.000Z')
  })
})
