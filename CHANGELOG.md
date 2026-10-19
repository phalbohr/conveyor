# Changelog

## Unreleased

- GitLab: one feature in several repositories. `repos` (`group`, `include`, `exclude`, `base`) makes the workspace of a task a folder with a worktree of every repository of the group side by side; the plan returns the repositories in merge order (`repos` in the stage result), every changed repository gets one merge request that is approved on its own, and the feature merges as a whole, in that order, only when every merge request is approved and green. Base CI is checked and guarded per repository. `repo_paths` in `local.yaml` uses existing clones, for example submodules of a parent repository; the others are cloned into `~/.conveyor/repos/`.
- GitLab group boards: `board.group` makes the board and its labels cover every project of the group. Tasks are named `project#number` (for example `frontend#12`) on the screen, in the log, and in commands such as `conveyor attach frontend#12`; issue work goes to the project of each issue, new tasks are created in `board.project`, and merge requests link the issue with its full reference.
- `conveyor init` checks the board before it writes anything and creates nothing when a check or the new settings fail. It accepts a URL for the project, recognizes a GitLab group and asks for the project for new tasks (`--group` without a terminal), and `board.project` must be a path, not a URL. A URL of another host than the one `gh` or `glab` works with is refused. A GitLab project or group that does not exist gives a readable error instead of `Cannot read properties of null`.
- A `gh`, `glab`, or `git` command that hangs (for example after the network drops) is stopped after 10 minutes, and the next cycle runs. Before, one hung call stopped the conveyor for good while the control screen still said `resumes next cycle`.
- The control screen flashes the header of a status column twice in yellow when a new task arrives in it.
- `conveyor init` ends with what happened and what to do next: it names where it created the labels, points to Plan → Issue boards on GitLab (before: Issues → Boards), and says that the conveyor exits now and starts again with `conveyor` after the board columns are set up; when the labels failed, it says to fix the cause and run `conveyor board update`.
- The control screen scrolls a page at a time with PgUp and PgDn, or Shift+↑↓ (on a Mac keyboard without these keys, and in Terminal.app, where Fn+↑↓ scrolls the terminal), in the opened task, watch, help, usage, log, and board check.
- The status columns of the control screen follow the board: backlog, needs input, queued, in progress, review.
- A started task that waits for a free `running` slot between stages (for example before the next part of a plan) moves to `conveyor::queued` and shows `waits for a free slot`; before, it stayed in progress with `waits for its next attempt`. Tasks that wait for merge checks or the base CI stay in progress.
- Higher priorities finish first: between two stages, a running task gives its slot to a waiting started task with a higher priority (for example one that just got its answer), moves to `conveyor::queued`, and continues at its next stage later. The next cycle starts at once. Before, the higher priority waited until the lower one finished its whole part.
- A pull or merge request that cannot be opened stops the task in `conveyor::needs-input` with the error; before, the conveyor ran the `merge` stage again in every cycle. On a group board without `repos`, the conveyor takes no issue of a project other than the one of its own clone (the log says why) and stops a started one with the hint to set `repos`; before, it pushed the branch to its own clone and failed to open the merge request in the project of the issue.
- `repos.projects` lists the repositories of a feature by their full paths, from any groups, instead of `repos.group`; their names are the last part of the path. Clones without `repo_paths` go to `~/.conveyor/repos/<full project path>`.
- Reset and cleanup remove a task folder whose repository folders are no worktrees (for example one left from before `repos` was set) instead of failing with `is not a working tree`.
- The triage sets the priority of new tasks only, so priorities set by hand stay. A priority it returns for an older task is logged as a suggestion (`triage: suggests priority 1 for #12 … (now 3); not applied`); before, it was applied silently.
- `parts: together` collects the parts of a plan in one draft pull request per repository instead of merging every part on its own: after the last part the `merge` stage rebases the branch, the conveyor marks the pull requests ready, and the whole task is reviewed and merged at once. The parts before the last skip `review` as well; the review of the last part covers all parts. The default `separate` keeps one pull request per part. A reset to `form::plan` keeps the parts of the plan (before, it dropped them, and the task ran as one part). The settings screen lists it under Team.
- `checks.ignore` lists CI jobs that never count, for the base branch and for pull requests (for example a deploy job without its secret); GitLab judges a pipeline by its other jobs. `checks.fix_base` chooses which red base the conveyor repairs: `all` (default, as before), `own` (only a base its own merge turned red, that is a job that passed in its pull request and before the merge fails after it; jobs the pull request does not run, such as deploys, and jobs that failed before are logged, and nothing waits), or `none`.
- A task branch that cannot be deleted is reported with the git error: reset says `The branch was not deleted: …`, and a finished task logs it. Before, the failure was silent, and a reset task could continue on its old remote branch.
- A task that waits for its merge checks or for the base CI after its merge is checked even when every `running` slot is taken; before, a merged task with green base CI could wait until a stage of another task finished.
- The stage templates set test and edit habits: a failing test first only for new behavior; single test cases or files while working and the full suite, type check, and build once at the end; long test output saved to a file instead of rerunning the command; no search-and-replace of ordinary words over many files. Existing projects keep their own stage files; copy the rules there by hand.
- When the branch of a pull request changes during review, approvals given after the new commit count; before, only approvals after the conveyor noticed the change counted, so an approval of the new commit could be lost. On GitLab the review request says that the Approve button (or the GitLab quick action `/approve` on the merge request) approves, and that a teammate approves because the conveyor opens merge requests as its own user.
- A merge request that GitLab blocks by its own rules (approval rules not met, unresolved threads, changes requested, blocked by another merge request) waits with that reason in the log (`merge waits: GitLab approval rules are not met yet`); before, the conveyor tried to merge it and counted failed merges. The setting `review.count_own_approvals` is labeled `Count own approvals`, which fits the settings screen.
- The `implement` and `review` stage templates also tell the harness to run checks in the foreground and wait for them, like `merge` and `fix-ci`.

## 0.2.2 — 2026-10-14

- GitLab: assigning the conveyor user to a task works with glab 1.119 and later, which reject field names with brackets (`assignee_ids[]`). Before, claiming a task on GitLab failed with `glab api PUT … failed (HTTP 0): ERROR`.

## 0.2.1 — 2026-10-13

- A pull request of the conveyor says `Part of #N` and never `Closes #N`. Before, with `close_on_done: true` GitHub closed the issue at the merge, the conveyor stopped seeing the task before its base CI check and post-merge stages, and the task stayed in `conveyor::in-progress` (sometimes with `fix::ci`) on a closed issue. Now the conveyor closes the issue itself when the task is done. Clean up such tasks by hand: set `conveyor::done` and remove `stage::`, `claimed-by::`, and `fix::ci`.
- The help names GitHub's "Auto-close issues with merged linked pull requests" setting (Settings → General → Issues): turn it off when pull requests are linked to issues by hand, or the issue closes before the conveyor finishes.

## 0.2.0 — 2026-10-13

- A missing or silent `gh`/`glab` gives a clear board error with the next step (`… is not installed or not in PATH`, `gh auth status`, `glab auth status`).
- The fix task of a red base branch starts even when every `running` slot is taken; before, the tasks waiting for it could block it forever.
- One fix at a time, on the whole board: the fixer carries the label `fix::ci`, taken under the lock `conveyor-lock/fix`. While it works, no other task on any workstation runs its `merge` stage, merges, or starts its own repair, so two tasks never fix the same failure in different ways; earlier stages go on. With a red base no new task starts either, and stage prompts of started tasks name the failing base checks and the fix task. The fixer starts outside the task limits. The control screen shows a yellow `CI freeze: #N <title> fixes the CI (@owner, stage or waiting answer, private artifact) · merges wait` line with the `conveyor release N [--force]` command to hand a stuck fixer over, and `waits: task #N fixes the CI first` on my tasks at `merge`; the log says `CI freeze: …` and `CI freeze over: …`.
- Comments that wait for a human name the commands: the new review request comment lists `/approve` with the needed approvals; failed merges and stages say "reply with any comment to retry"; both list `/fix`, `/fix_from:` with the allowed stages, and `/rework`, and say that `<notes>` is free text.
- A workstation accepts the fix task of a red base from any member with write access instead of creating a second one.
- The `fix-ci` template and the fix task of a red base keep the base version when the base already fixes the same failure.
- A task whose checks failed is rebased onto a newer base branch first and waits for its new checks; before, every task that waited for a red base ran its repair stage on the old failures once the base was green.
- Landing first pushes commits that a failed push left in the workspace (for example after a network timeout) and waits for their checks, instead of judging the old pull request head.
- A missing result file of a command harness (opencode, kilo, …) shows the last output as readable lines instead of raw JSON events. Long lines end before a cut word, so a token is never left half visible, and terminal control sequences are removed (also in the session logs).
- Tasks that wait to merge or wait for the base CI after their merge no longer take a `running` slot.
- The control screen shows why a task waits to merge (for example `○ merge waits: the base branch CI is red; task #N fixes it first`) instead of `waits for its next attempt`.
- `w` on a task and `conveyor watch <number> [-f]` show what the harness does in its stage while it runs (commands, edited files, messages, errors) for claude, codex, opencode, and kilo. Turn it on with the personal setting `session_logs: true`. The log is `~/.conveyor/sessions/<project>/<number>.log` (mode 0600, secrets redacted), outside the repository; the conveyor deletes it when the task is done or reset.
- The `merge` and `fix-ci` stage templates tell the harness to run checks in the foreground and wait for them: a headless harness cannot schedule a later wakeup.
- Questions of a stage say that the answer is free text in your own words.
- A retry time in the past shows as `resumes next cycle` (or `resumes on start` while the conveyor is stopped).
- After a soft stop the control screen says `All running stages finished. The conveyor stopped.`

### Development

- `npm run typecheck` also checks the tests; unused locals and parameters are errors.
- `npm run lint` runs oxlint; CI and `prepublishOnly` run it.
- Tests use their own git identity and settings, so a global `commit.gpgsign` or another default branch on the machine does not break them.
- The npm package also contains `CHANGELOG.md` and `SECURITY.md`.

## 0.1.0 — 2026-10-12

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

- A model that stops at its length limit gives a readable error with token counts, and the next attempt splits the work into small steps.
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
