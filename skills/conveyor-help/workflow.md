# Working with the conveyor

## The idea

The board (GitHub or GitLab issues) holds every task and its state. Each team member runs `conveyor run` on their own machine. It takes tasks within personal limits and moves each task through the configured stages. Agents do the work inside a stage; humans decide at the gates. Every agent writes only to its task's workspace and branch; the conveyor writes to the board.

## The full chain

| # | Step | Who | Board label |
|---|---|---|---|
| 1 | Write an idea, story, or story with plan as an issue, or shape it in `conveyor new` | human | `conveyor::idea` / `story` / `plan` |
| 2 | Triage: priorities 1–4 and "blocked by" links for new tasks | agent (triage settings) | `priority::N` |
| 3 | Claim: the first workstation with free limits locks the task (branch `conveyor-lock/<number>`) | conveyor | `claimed-by::<user>`, `conveyor::in-progress` |
| 4 | `story` stage (only if `pickup_from: idea`): idea → user story in `formats/story.md` | agent | in-progress |
| 5 | Gate idea → story: questions or approval in issue comments, depending on `transitions.idea_to_story` | human or agent | `conveyor::needs-input` while waiting |
| 6 | `plan` stage (if `pickup_from` is `idea` or `story`) and gate story → plan | agent, human | in-progress / needs-input |
| 7 | `implement`, `review`, and custom stages before `merge`, each in the task worktree on branch `conveyor/<number>`; the conveyor commits and pushes after every stage | agents | in-progress |
| 8 | `merge` stage prepares the branch; the conveyor opens a pull/merge request | agent, conveyor | — |
| 9 | Merge gate by `transitions.merge`: `human` → review; `ai` → merge; `smart` → the merge stage decides by `smart/merge.md` | human or agent | `conveyor::review` while waiting |
| 10 | Review: `/merge` or Approve → merge; `/fix`, `/fix_from:`, `/rework` → back to work | human | review / in-progress |
| 11 | Landing: waits for blockers and CI, merges under the lock `conveyor-lock/merge` | conveyor | — |
| 12 | Post-merge stages with `when: success`, `failure`, or `always` (for example `fix-ci`) | agents | in-progress |
| 13 | Done: issue closed, lock, workspace, and task branch removed | conveyor | `conveyor::done` |

Questions, approvals, and errors always go to the issue as comments. Any reply without the conveyor marker is the answer; the next cycle continues the stage. `conveyor attach <number>` answers in a live session instead.

## Task numbers

A task is an issue on the board, and the conveyor names it by the issue number: GitHub `github.com/owner/repo/issues/51` and GitLab issue `#51` are task `51`.

- Commands take the bare number: `conveyor attach 51`, `conveyor release 51`. In a shell, `#51` starts a comment, so write `51`.
- Branches carry the number: `conveyor/51` (work), `conveyor-lock/51` (claim).
- Own identifiers, such as `US-E4-01`, can stay in the issue title; the conveyor ignores them.

## Setup

1. Install: `npm install -g @phalbohr/conveyor`; sign in `gh` or `glab`; install the harness CLIs your stages use.
2. In the repository: `conveyor init` (reads the board from `git remote origin`). Commit `.conveyor/` except `local.yaml`.
3. Each member: `conveyor settings` → Personal (limits, chat language), then `conveyor skill install` for agent help.
4. GitHub board columns: set `board.github_project: <number>` and choose the field `Conveyor` as the column field of a board view. GitLab: create an issue board with lists for the `conveyor::*` labels.

## Team settings

- Team settings are the committed files in `.conveyor/`; change them on a branch and merge them through a pull request like code. `local.yaml` stays personal.
- `conveyor run` reads the settings from your working copy and reloads them every cycle; changes to `harnesses` need a restart of `run`.
- Newer team settings: `conveyor run` fetches `origin` every cycle and warns once when the main branch has commits in `.conveyor/` that your branch lacks; the status screen shows the same notice. Run `git pull` to take them. Your own uncommitted or unpushed changes never trigger it.
- Settings outside the repository (`init --path`) belong in a shared git repository; members link it with `conveyor init --use <dir>`.

## Daily use

| I want to … | Do |
|---|---|
| see my tasks, limits, subscription windows | `conveyor` (status screen; `h` help) |
| start working the board | `conveyor run` (Ctrl+C stops; tasks resume on the next start) |
| add a task | `conveyor new`, or an issue with a `conveyor::idea`, `story`, or `plan` label |
| answer a question | reply in the issue, or `conveyor attach <number>` |
| merge a reviewed task | `/merge` on the issue or pull request, or Approve. GitLab: Approve the MR or `/merge` on the issue (`/merge` in an MR is a GitLab quick action) |
| request small fixes | `/fix <notes>` (from `plan`) or `/fix_from: <stage> <notes>`; branch and pull request stay |
| start over | `/rework <notes>` or the label `conveyor::rework`; new branch from `plan` on |
| give a task back | `conveyor release <number>` (`--force` for private tasks of others) |
| change settings | `conveyor settings`, or `conveyor config list|get|set`, `conveyor config stage add|remove|move` |

## Files and what they control

| File | Controls |
|---|---|
| `config.yaml` (team) | board, `pickup_from`, `transitions`, `stages`, `defaults`, `triage`, `harnesses`, `artifacts`, `hooks`, `timeouts`, `retry`, `merge_method`, `review.approvals`, `language.docs` |
| `local.yaml` (personal) | `limits` (running, awaiting_me, awaiting_review, daily_tokens, subscription reserves), `poll_interval`, `pickup`, `workspace.root`, `language.chat`, personal `harnesses` overrides, private `artifacts` |
| `stages/<name>.md` | what a stage does: Liquid template with `issue`, `stage`, `attempt`, `artifacts`, `review`, `language`, `formats`; frontmatter `skills: [a, b]` attaches skills (claude stages) |
| `smart/<gate>.md` | when a smart gate asks a human (`idea-story`, `story-plan`, `merge`) |
| `live/new.md`, `live/attach.md` | instructions for the live sessions |
| `formats/story.md` | the story structure |
| `triage.md` | how triage orders tasks |

`conveyor config list` describes every key that `conveyor config set` can change.

## Concepts

- **Gate modes**: `interactive` (questions and approval), `autonomous` (no questions), `smart` (asks only by the criteria in `smart/<gate>.md`).
- **Stages**: ordered list in `config.yaml`. `story`, `plan`, and `merge` are reserved; custom stages go after `plan`, before or after `merge`. Remove a line to drop a stage; add `review-2` with another harness for a second reviewer.
- **Stage files**: every stage needs its instructions in `stages/<name>.md`. Adding a stage through `conveyor settings` or `conveyor config stage add` creates a stub there. A configured stage whose file is missing, empty, or still the stub has no description: `conveyor run`, the status screen, and the settings editor warn about it. The settings editor's "Stage files" section lists every stage and every file in `stages/` with on/off; switching a file on adds the stage before `merge`, switching it off removes the stage from `config.yaml` and keeps the file.
- **Harnesses**: `claude` and `codex` are built in; `opencode`, `pi`, `openhands`, and `agent-zero` are presets in `config.yaml` under `harnesses`. Any CLI works with `command`, `args`, and `env`; placeholders `{prompt}`, `{model}`, `{effort}`, `{workspace}`, `{result}`.
- **Models**: the `model` value goes to the harness as is. Claude takes aliases (`opus`, `sonnet`, `haiku`, `fable`: always the newest version) or full names (`claude-opus-5-5`, `claude-opus-5`); pin a full name in the team config for stable behavior. `conveyor models [harness]` lists the models and efforts of a harness: Claude from a built-in list, Codex from `codex debug models`, OpenCode from `opencode models` (includes self-hosted providers from `opencode.json`), Pi from `pi --list-models`, any harness from its `models: {command, args}` setting (for example a LiteLLM `/v1/models` query); `--refresh` asks again. The settings editor offers these lists (`←` `→`, Enter, `other…` for any name, `m` to refresh). `conveyor run` warns at start about a model a harness does not list; a stage whose harness rejects the model goes to a human at once without retries.
- **Limits** (personal): the conveyor claims a new task only while running tasks, tasks waiting for you, tasks waiting for your review, daily tokens, and subscription reserves are all below their limits. Answered tasks resume before new ones.
- **Timeouts**: stage and stall timeouts retry with backoff; after `retry.max_attempts` the task asks a human. Claims of others are released after 30 minutes without heartbeat or after `timeouts.waiting` in a waiting state.

## Recipes

**A stage on a self-hosted model through LiteLLM (OpenCode):**
1. Add a provider to OpenCode's `opencode.json` with `"npm": "@ai-sdk/openai-compatible"` and `"options": {"baseURL": "http://localhost:4000/v1", "apiKey": "..."}`.
2. `conveyor config set stages.implement.harness opencode`, then `conveyor config set stages.implement.model litellm/<model>`.

**OpenHands with a personal endpoint:** in `local.yaml`:
```yaml
harnesses:
  openhands:
    env: {LLM_BASE_URL: "http://localhost:4000", LLM_API_KEY: "sk-local"}
```

**A second reviewer on another harness:** `conveyor config stage add review-2`, `conveyor config set stages.review-2.harness codex`, write `stages/review-2.md`.

**Repair broken CI after merge:** `conveyor config stage add fix-ci --after-merge --when failure`, write `stages/fix-ci.md`.

**Let the agents merge simple changes:** `conveyor config set transitions.merge smart` and list the risky cases in `smart/merge.md`.

**Use a skill in a stage:** add `skills: [name]` to the frontmatter of `stages/<stage>.md`. Lookup order: project `.claude/skills/`, `~/.claude/skills/`, installed plugins (`plugin:skill`).

**Keep plans out of the repository:** team `artifacts.plan.allow_private: true`, then personal `artifacts.plan: {store: path, path: "~/Plans/{project}"}`.
