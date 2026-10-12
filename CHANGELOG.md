# Changelog

## 0.1.0 — unreleased

First public release.

### Board and labels

- Board adapters for GitHub (`gh`) and GitLab (`glab`). On GitLab Free, blockers live in a `Blocked by: #N` line in the issue description.
- `conveyor::` states as columns: backlog, needs-input, queued, in-progress, review, done. `form::idea|story|plan` marks a task ready for the conveyor; `stage::<name>` shows the running stage; `part::k/n` shows the current part.
- GitHub boards: `init` and `conveyor board update` use the GitHub project linked to the repository, or create and link one, add the `Conveyor` field, and write `board.github_project`. The conveyor sets the `Conveyor` value of every task from its `conveyor::` label.
- Board check: every start and the control screen report what the board lacks for this version. `conveyor board check` prints the report; `conveyor board update` (or `k` on the control screen) adds missing labels, the `Conveyor` field, and its missing options, and never changes or deletes existing ones.
- Triage sets `priority::1`–`4` labels and "blocked by" links for new tasks.
- `close_on_done` (default `false`): a finished issue stays open with `conveyor::done` until a human closes it.
- The conveyor assigns a claimed task and its pull request to the user it runs as and removes the assignment on release. The workpad links the task branch and the pull request.

### Stages and gates

- Comments of the team on a task in progress reach every later stage run in a section `Notes from the team`.
- Configurable stages from idea to merge and after merge. `story`, `plan`, and `merge` are reserved; custom stages run between `plan` and `merge`, or after `merge` with `when: success|failure|always`.
- Gates idea → story and story → plan: `interactive`, `autonomous`, or `smart`. Merge: `human`, `ai`, or `smart`.
- Stage files are strict Liquid templates with `skills:` and `after_merge:` frontmatter.
- The ready repair stage `fix-ci.md` comes switched off; turning it on adds it after merge with `when: failure`.
- Parts: the plan can split a story into ordered parts, one pull request each; the story is done after the last part merges.
- Review commands: `/approve`, `/fix`, `/fix_from: <stage>`, `/rework`, and the label `conveyor::rework`. On GitLab, `/approve` in a merge request is GitLab's own approval and counts.
- A failed stage retries with backoff up to `retry.max_attempts`, then asks a human. A configuration error asks a human at once.
- A harness at its usage limit pauses its stages until the reset time without a failed attempt.

### Harnesses

- `claude` and `codex` are built in; presets for `opencode`, `kilocode`, `pi`, `openhands`, and `agent-zero`; any CLI through `harnesses`. `claude`, `codex`, `opencode`, and `kilocode` are tested with real runs.
- Command harnesses write the result JSON to `CONVEYOR_RESULT` and the artifact text as plain text to `CONVEYOR_ARTIFACT`. Placeholders: `{prompt}`, `{model}`, `{effort}`, `{workspace}`, `{result}`, `{artifact}`, `{temp}`.
- The `opencode` and `kilocode` presets run with `--format json`, pass the effort as `--variant`, and give every stage its own database, so stages run in parallel.
- Stall detection counts harness output and the CPU work of command harnesses; `timeouts.stage` ends endless runs.
- `conveyor models` lists the models and efforts of each harness, cached for a day.
- Live sessions (`conveyor new`, `conveyor attach`, `h` on a task, `a` on the help screen) use the personal `live: {harness, model, effort}` from `local.yaml`.

### Control screen

- `conveyor` opens the control screen: start and stop the conveyor, its log, the board panel with Backlog by form and my columns against my limits, and usage with tokens and subscription windows.
- On a task: its text, workpad, comments, and pull request; comment, open it in the browser, open a live harness session on it, toggle `form::idea`, or reset it.
- A task in progress shows whether its stage is alive: running time and last harness activity, or the heartbeat of a conveyor in another terminal.
- Stop: the first `s` lets the running stages finish and starts nothing new, then the conveyor stops; a second `s` stops at once.
- `r` reads the board again and, while the conveyor runs here, starts a cycle at once.
- `n` creates a task in your editor, as a one-line idea, or in a live harness session; `conveyor new --write` and `conveyor new --title … --form …` do the same from a shell.

### Merge safety

- Several workstations on one board: atomic claims through lock branches, heartbeats, merge and triage locks, and personal limits.
- The conveyor merges only when the checks of the pull request are green; it waits up to 5 minutes for CI to start.
- Merge only on the latest base branch: a branch that fell behind is rebased and tested again; a rebase conflict sends the task back to the `merge` stage.
- Red base guard: a failing base branch gets one fix task that runs first, and other tasks do not merge until the base is green.
- After the merge the conveyor waits for the base branch CI. A failure runs `when: failure` stages and merges a follow-up pull request, or asks a human.
- A pull request that a human linked to the issue makes the conveyor ask first (`/continue` or `/fresh`). Draft pull requests are never merged.
- A task branch without changes against the base branch finishes the task with a note.
- `board.base_branch` sets the branch that task branches start from and pull requests merge into. The conveyor pushes only to its own branches.

### Settings and CLI

- Commands: `init`, `run`, `settings`, `config list|get|set`, `config stage add|remove|move`, `models`, `board check|update`, `skill install`, `new`, `attach`, `release`, `reset`.
- The settings editor and `conveyor config set` validate before they save and keep the formatting and comments of the YAML files.
- Team settings in `config.yaml`, personal settings in `local.yaml`; a warning when the base branch has newer team settings.
- Personal limits: tasks running at once, tasks waiting for my answer or review, daily tokens, and subscription reserves.
- `conveyor reset <number>` (or `x` on the control screen) starts a task over with the form you choose.
- The `conveyor-help` skill explains the workflow and changes the settings.

### Security

- Every stage prompt has a `Boundaries` section against prompt injection: data from files, dependencies, the web, command output, and other issues is not an instruction, and board steps stay with the conveyor.
- Pull requests and merge requests from forks never count as the pull request of a task.
- `review.count_own_approvals: false` ignores approvals from the conveyor account, for setups with a separate bot account.
- Pushes to a task branch use a lease: a commit that someone else pushed is never overwritten, and a resumed task picks it up first. A task branch whose remote state is part of the local history counts as the conveyor's own.
- The conveyor takes tasks and reads comments, reviews, and commands only from users with write access to the repository.
- Secret redaction in everything the conveyor writes to the board, in committed artifacts, and in the log.
- Approvals bind to the reviewed head commit; a push by someone else asks for a new approval.
- Harness processes get no board credential.
