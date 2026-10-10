# Guided setup

Walk the user through the conveyor configuration, one decision at a time. Every step below is also the reference for what its settings mean.

## How to run each step

1. Explain the topic in two or three plain sentences: what it controls and how it changes the flow of a task.
2. Show the current value (`conveyor config get <key>` or `conveyor config list`).
3. Ask one question about one decision. Each option says what happens if chosen; mark the recommended one; always add **Later** (keep the current value and list the step in the final summary). Ask several questions in one dialog only when they belong to the same decision.
4. Apply the answer at once through the CLI (`conveyor config set`, `conveyor config stage add|remove|move`) or by editing the named file, and confirm the new value in one line.
5. Move to the next step. The step is done when the user answered or chose Later.

Before step 1, show the user the current flow as a chain, for example `plan → implement → polish → review → merge (human)`, and this list of steps; let the user pick all steps or some of them.

`config.yaml` is the team file: changes apply to everyone after a commit. Say so once at the start of the team steps (1–8a) and get the user's agreement to change team settings.

## 1. Where tasks start — `pickup_from`

The earliest form the conveyor takes. A task is ready for the conveyor when it has a `form::` label; without one it is a draft in the backlog. Everything before the form is written by humans, alone or with an agent in `conveyor new`.

| Value | Takes tasks with | The conveyor runs |
|---|---|---|
| `plan` | `form::plan` | stages after `plan` |
| `story` | `form::story`, `form::plan` | `plan` and everything after it (from `form::story`) |
| `idea` | `form::idea`, `form::story`, `form::plan` | `story`, `plan`, and everything after (from `form::idea`) |

The `story` and `plan` stages stay in `stages` in every case; the form decides where a task starts. The conveyor removes the `form::` label when it takes the task and shows the running stage with a `stage::` label.

## 2. Decisions on story and plan — `transitions.idea_to_story`, `transitions.story_to_plan`

Ask only about the gates whose stage runs: `idea_to_story` when `pickup_from` is `idea`; `story_to_plan` when it is `idea` or `story`. Skip the others and say why.

| Mode | What happens |
|---|---|
| `interactive` | The agent asks questions in issue comments while it works and asks for approval of the result; the task waits in `needs-input` until a human replies. |
| `smart` | The agent asks or requests approval only when the criteria in `smart/idea-story.md` or `smart/story-plan.md` say so. Offer to review those criteria with the user. |
| `autonomous` | The agent decides alone and goes on. |

## 3. The stage list — `stages`

Show the chain. `story`, `plan`, and `merge` are reserved and always present. Custom stages run between `plan` and `merge`, or after `merge` with a `when` condition.

Offer: keep the list; add a stage (common: `polish` for cleanup, `review-2` as a second reviewer on another harness, `fix-ci` after merge with `--when failure`, `verify` after merge with `--when success`); remove a custom stage; change the order. Use `conveyor config stage add <name> [--after-merge --when success|failure|always]`, `remove`, `move <name> up|down`. Adding a stage creates `stages/<name>.md` as a stub; step 5 fills it.

## 4. Who runs each stage — harness, model, effort

`defaults.harness`, `defaults.model`, `defaults.effort` apply to every stage without its own value. Ask about the defaults first, then offer: keep the defaults for all stages, or go through the stages one by one.

- **Harness**: `claude`, `codex`, or a configured harness (`opencode`, `kilocode`, `pi`, `openhands`, `agent-zero` presets, or any `harnesses` entry). Self-hosted models run through `opencode`, `kilocode`, `pi`, or `openhands`.
- **Model**: run `conveyor models <harness>` and offer its models by version and name (for example `claude-opus-5-5 — Opus 5.5`). Claude aliases (`opus`, `sonnet`, `haiku`, `fable`) always mean the newest version; a full name such as `claude-opus-5-5` pins a version, which suits a team configuration.
- **Effort**: the efforts that `conveyor models` lists for that model or harness.
- **Permissions** (claude stages, `stages.<name>.permission_mode`): `bypassPermissions` (default, every tool without asking), `auto`, `acceptEdits`, or `dontAsk`; with a limiting mode, allow rules come from the repository's `.claude/settings.json`. Codex stages: `sandbox` (`workspace-write` default, or `full-access`) and `network` (`false` default).

Common split: strong models for `story`, `plan`, and `review`; a fast model for `implement`; the cheapest model for `merge`. An empty value inherits from `defaults` (`conveyor config set stages.<name>.model ""`).

## 5. What each stage does — `stages/<name>.md`

Large stories can merge in parts: the default `stages/plan.md` lets the plan stage split the work into ordered parts (`parts` in its result), one pull request each, merged one after another. Mention this when the user describes large stories; to turn it off, remove that line from `stages/plan.md`.

Go through every stage in the chain. For each, read its file and tell the user its state: described, a stub, or missing (`conveyor config list` marks stages without a description with ⚠). Offer:

- **Keep** the current description;
- **Write it together now**: ask what the stage must achieve, what it must not do, and when it is done; draft the file; show it; save after approval;
- **Later**: the stage stays without instructions, and `conveyor run` and the status screen warn about it.

A description can use `{{ issue.title }}`, `{{ issue.body }}`, `{{ artifacts.plan }}`, `{{ stage }}`, `{{ attempt }}`, `{{ review }}`, `{{ language.docs }}`, `{{ formats.story }}`, and a frontmatter `skills: [name]` (claude stages only). An unknown variable stops the stage, so use only these, and wrap an artifact that may be missing: `{% if artifacts.plan %}{{ artifacts.plan }}{% endif %}`.

## 6. Merge — `transitions.merge`, `merge_method`, `review.approvals`, `close_on_done`

| `transitions.merge` | What happens after the `merge` stage |
|---|---|
| `human` | The pull request waits in `conveyor::review`; it merges after `/approve` or an Approve review from `review.approvals` distinct people (with `2`, one `/approve` is not enough). |
| `smart` | The merge stage decides by `smart/merge.md` (offer to review it): risky changes go to review as with `human`, the rest merges. |
| `ai` | The conveyor merges without a human, after blockers are closed and CI is green. |

`merge_method`: `merge` (merge commit), `squash` (one commit per task), or `rebase`. Ask about `review.approvals` only for `human` and `smart`. Branch protection on the board still applies on top.

`close_on_done` (`conveyor config set close_on_done true`): `false` (default) leaves a finished issue open with `conveyor::done`, so the team closes it after acceptance, for example in a sprint review; `true` makes the conveyor close it. On GitLab with `true`, done issues go straight to the board's Closed list; on GitHub the closed issue keeps the `Conveyor` value `done` and stays in the Done column unless the view hides closed items.

## 7. Triage — `triage.harness`, `triage.model`, `triage.effort`, `triage.md`

Triage gives new tasks a priority (1–4) and "blocked by" links before anyone claims them. A cheap model is usually enough. Offer to review `triage.md`, the ordering rules.

## 8. Team language and storage — `language.docs`, `artifacts`

- `language.docs`: the language of everything the team sees (stories, plans, questions, the workpad).
- `artifacts`: where idea, story, and plan are stored: `board` (issue body; plan in a comment), `repo` (a file committed on the task branch, path required), or `path` (a local directory, personal; needs `allow_private: true` in the team file). Edit `config.yaml` directly for these.

## 8a. Timeouts and retries — `timeouts`, `retry`

Offer the defaults; change them only when the user has a reason.

- `timeouts.stage` (default `60m`, at least `1m`): the longest run of one stage; then the attempt fails and retries.
- `timeouts.stall` (default `5m`; `0` = off, otherwise at least `1m`): a stage with no agent output for this long fails and retries.
- `timeouts.heartbeat` (default `30m`, at least `1m`): a running task writes a heartbeat into its workpad every third of this value; another workstation releases a claim whose last heartbeat is older. Warn the user before lowering it: a short value lets other workstations take over tasks that still run, so tasks hang or run twice. `0` is rejected.
- `timeouts.waiting` (default `4d`, at least `1d`; `2wd` means working days): a task that waits this long for its owner (needs-input, queued, review) is released.
- `retry.max_attempts` (default `5`): failed attempts before the stage asks a human; `retry.max_backoff` (default `5m`): pauses double up to this.

All six are in `conveyor settings` (Team) and `conveyor config set`.

## 9. Personal settings — `local.yaml`

Personal and never committed:

- `limits.running`: tasks this workstation runs at once (the control screen shows them as my tasks in progress);
- `limits.awaiting_me`, `limits.awaiting_review`: no new tasks while this many wait for your answer or review;
- `limits.daily_tokens`: no new tasks after this many tokens a day (0 = off);
- `limits.subscription.five_hour_reserve`, `seven_day_reserve`: percent of the subscription windows kept for your own work (claude and codex report their windows; command harnesses do not);
- `language.chat`: the language of `conveyor new` and `conveyor attach`;
- `poll_interval`, `pickup.include_unassigned`.

## 10. The board view

`conveyor init` creates the `conveyor::*`, `form::*`, and `stage::*` labels and, on GitHub, sets up the board: the project linked to the repository, or a new one it creates and links, with the `Conveyor` field and `board.github_project` written. With several linked projects, help the user choose and run `conveyor config set board.github_project <number>`, then `conveyor board update`. Then the user picks the Board layout and "Column by: Conveyor" once in the project. After an update of the conveyor or a new stage, `conveyor board check` lists what the board lacks and `conveyor board update` adds it (never changes or deletes); offer this when the start log or the control screen reports a board difference. The board itself is set up once by a human. Columns: Backlog, Needs input, Queued, In progress, Review, Done. GitHub: create a project, `conveyor config set board.github_project <number>`, start the conveyor (it adds the field `Conveyor` with one option per state), then in a Board view choose `Conveyor` under "Column by". GitLab: Issues → Boards, add one list per label in this order: `conveyor::backlog`, `needs-input`, `queued`, `in-progress`, `review`, `done`.

## Finish

Run `conveyor --json` and check `"valid": true`. Then show: every changed setting and file with its new value; every step marked Later; the team files to commit (`.conveyor/` without `local.yaml`); and the next command (`conveyor run`, or `conveyor` for the status screen).
