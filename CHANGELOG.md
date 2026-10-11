# Changelog

## 0.1.0 — 2026-10-08

First public release.

- Board adapters for GitHub (`gh`) and GitLab (`glab`), with GitHub Projects mirroring and the GitLab Free fallback for blockers.
- Configurable stages from idea to merge and after merge, with interactive, autonomous, and smart gates.
- Harnesses: `claude` and `codex` built in; presets for `opencode` and `kilocode` (verified with real runs), `pi`, `openhands`, and `agent-zero` (not yet verified with real runs); any CLI through `harnesses`.
- Several workstations on one board: atomic claims, heartbeats, merge and triage locks, personal limits, and subscription reserves.
- Board labels: `conveyor::` states as columns (backlog, needs-input, queued, in-progress, review, done), `form::idea|story|plan` marks a task ready for the conveyor, `stage::<name>` shows the running stage.
- Review command `/approve` (one approval; the conveyor merges after `review.approvals` distinct approvals). On GitLab, `/approve` in a merge request is GitLab's own approval and counts.
- `close_on_done` (default `false`): finished issues stay open with `conveyor::done` until a human closes them.
- The init menu has Cancel and Esc; the help screen starts a live session with the conveyor-help skill on `a`.
- GitHub boards: `init` and `conveyor board update` use the project linked to the repository or create and link one; the board check reports a missing project.
- `n` offers `e` (write title, form, and text in your editor), `i` (one-line idea), and `a` (agent); `conveyor new --write` and `conveyor new --title … --form …` do the same from a shell.
- A task with a pull/merge request linked by a human asks first: `/continue` from its branch or `/fresh`; draft pull/merge requests are never merged.
- Red base guard: a failing base branch gets one fix task that runs first; other tasks do not merge until the base is green, and their agents know the failures are not theirs.
- A task branch without changes against the base branch finishes the task with a note instead of failing to open a pull request in a loop; a missing-result error shows the harness output without the Kilo/OpenCode database migration banner.
- The control screen shows dates as `11.10. 18:24` and a 24-hour clock.
- Soft stop: the first `s` lets running stages finish and starts nothing new, then stops; a second `s` stops at once.
- Merge only on the latest base branch: a branch that fell behind is rebased and tested again before merge; a rebase conflict sends the task back to the merge stage.
- After the merge the conveyor waits for the base branch CI; a failure runs `when: failure` stages and merges a follow-up pull request, or asks a human.
- After failed checks or a failed merge, `/fix`, `/fix_from: <stage>`, and `/rework` in a reply send the task back to work with the error and your notes.
- The workpad links the task branch and the pull request; claimed tasks without an assignee get one.
- The control screen has a queued column, as the board: answered tasks that wait for a free slot.
- The conveyor merges a pull request only after its checks started: without any check it waits up to 5 minutes for CI; before, it merged right after opening the pull request, before CI ran.
- The conveyor assigns a task and its pull request to the user it runs as and removes the assignment on release. The pull request says `Closes #N` when the conveyor would close the issue anyway (`close_on_done` and the last part), otherwise `Part of #N`.
- `r` on the control screen starts a conveyor cycle at once while the conveyor runs; the log records the start of every stage.
- Model lists of the harnesses expire after a day, so new models appear without `--refresh`; `r` on the control screen says that it reads the board again and when it is done.
- The `opencode` and `kilocode` presets pass the stage effort as `--variant`.
- Command harnesses count CPU work of their processes as activity, so a model that streams one long answer without output is not aborted as stalled; `timeouts.stage` still ends endless runs.
- `conveyor config set` and the settings editor set `sandbox` and `network` of codex stages.
- A usage limit of a harness pauses its stages until the reset time instead of counting failed attempts.
- The review stage template no longer asks the agent to commit: the conveyor commits after the stage, and sandboxed agents cannot write `.git`.
- A missing result names the exit code of the harness; a result file that is not JSON says so with its first characters.
- Released started tasks show first in the Backlog panel (`+N released`) and the conveyor resumes them before new tasks; a stage that runs hides the attempt number and the last error of earlier attempts.
- Reset: `x` on a task in the control screen or `conveyor reset <number> [--form]` stops it, closes its pull request, deletes its branch and workspace, clears the workpad, and returns it to Backlog as idea, story, plan, or draft.
- `limits.running` counts my tasks in progress that wait for a retry; before, a failed stage freed its slot and the conveyor claimed more tasks than the limit.
- The `opencode` and `kilocode` presets run with `--format json`: without a terminal both print nothing until the end, so the stall timeout aborted working stages; JSON events arrive on every step.
- The control screen shows whether a task in progress is alive: running time and last harness activity, or the heartbeat of a conveyor in another terminal. `s` stops at once: it aborts triage and the running stages and logs which. An existing blocked-by link no longer logs an error.
- Workpad state stays readable when a harness error contains color codes or other control characters; before, such an error broke the hidden state and the task restarted at the wrong stage.
- OpenCode and Kilo stages run in parallel: each run gets its own database (`OPENCODE_DB`, `KILO_DB`), new placeholder `{temp}`. A failed model listing is no longer cached, so `run` warns about an unknown model again; harness errors in the log have no color codes.
- Live sessions (`new`, `attach`, `h`, help `a`) use the personal `live: {harness, model, effort}` from `local.yaml`; `opencode` and `kilocode` start in their interactive mode; a failed session shows its exit code.
- `board.base_branch`: the branch that task branches start from and pull requests merge into (default: the default branch of the repository). The conveyor pushes only to `conveyor/<issue>` branches, so a base branch open only to pull requests works.
- Board upgrades: every start and the control screen report what the board lacks for this version; `conveyor board update` (or `k`) adds it on request and never changes or deletes existing labels or fields.
- Parts: the plan can split a story into ordered parts, one pull request each; the story is done after the last part merges.
- Command harnesses write the artifact text (for example the plan) as plain text to the file in `CONVEYOR_ARTIFACT` (placeholder `{artifact}`) and set only `artifact.kind` in the result JSON. Weaker self-hosted models broke the JSON when they escaped a long plan as a string and saved no plan; `artifact.content` inside the JSON still works.
- Board panel on the control screen: Backlog by form and my columns against my limits; open a task with its text, workpad, comments, and pull request; comment, open in the browser, open it in a live session with the harness, and toggle `form::idea`.
- Control screen with a live log, settings editor, `new`, `attach`, `release`, `config`, `models`, and the `conveyor-help` skill.
- Trust checks: tasks, comments, reviews, and commands only from users with write access; secret redaction on the board, in committed artifacts, and in the log; approvals and merges bound to the reviewed head commit.
