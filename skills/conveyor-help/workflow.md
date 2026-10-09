# Working with the conveyor

## The idea

The board (GitHub or GitLab issues) holds every task and its state. Each team member runs `conveyor run` on their own machine. It takes tasks within personal limits and moves each task through the configured stages. Agents do the work inside a stage; humans decide at the gates. Each agent works in its task's workspace and branch, and the conveyor writes to the board. The agent runs as your user: with the default `permission_mode: bypassPermissions` it can read and change anything your user can, including git and `gh` credentials. Limit it with `permission_mode` or run the conveyor in a container or under a separate user.

## The full chain

| # | Step | Who | Board label |
|---|---|---|---|
| 1 | Write an idea, story, or story with plan as an issue, or shape it in `conveyor new`. Without a form it is a draft; with a form the conveyor may take it | human | `conveyor::backlog` + `form::idea` / `story` / `plan` |
| 2 | Triage: priorities 1–4 and "blocked by" links for new tasks | agent (triage settings) | `priority::N` |
| 3 | Claim: the first workstation with free limits locks the task (branch `conveyor-lock/<number>`) and removes the form | conveyor | `claimed-by::<user>`, `conveyor::in-progress` |
| 4 | `story` stage (for `form::idea`): idea → user story in `formats/story.md` | agent | in-progress + `stage::story` |
| 5 | Gate idea → story: questions or approval in issue comments, depending on `transitions.idea_to_story` | human or agent | `conveyor::needs-input` while waiting, then `queued` or in-progress |
| 6 | `plan` stage (for `form::idea` and `form::story`) and gate story → plan | agent, human | in-progress / needs-input + `stage::plan` |
| 7 | `implement`, `review`, and custom stages before `merge`, each in the task worktree on branch `conveyor/<number>`; the conveyor commits and pushes after every stage | agents | in-progress + `stage::<name>` |
| 8 | `merge` stage prepares the branch; the conveyor opens a pull/merge request | agent, conveyor | — |
| 9 | Merge gate by `transitions.merge`: `human` → review; `ai` → merge; `smart` → the merge stage decides by `smart/merge.md`. With `review.approvals: 2`, two different people must approve or write `/approve` | human or agent | `conveyor::review` while waiting |
| 10 | Review: `/approve` or an Approve review → merge once `review.approvals` people approved; `/fix`, `/fix_from:`, `/rework` → back to work. An approval counts only for the head commit under review; a push by someone else asks for a new approval | human | review / in-progress |
| 11 | Landing: waits for blockers and CI, merges under the lock `conveyor-lock/merge` | conveyor | — |
| 12 | Post-merge stages with `when: success`, `failure`, or `always` (for example `fix-ci`) | agents | in-progress |
| 13 | Done: lock, workspace, and task branch removed; the issue stays open for a human to close (for example after a sprint review), or the conveyor closes it with `close_on_done: true` | conveyor | `conveyor::done` |

Any task in `conveyor::needs-input` (a gate question or approval, a stage question, or an error) that gets an answer moves to `conveyor::queued` when the owner's workstation has no free slot, and to `conveyor::in-progress` when the next cycle starts it. Questions, approvals, and errors always go to the issue as comments. Any reply without the conveyor marker from a user with write access to the repository is the answer; the next cycle continues the stage. `conveyor attach <number>` answers in a live session instead.

## Task numbers

A task is an issue on the board, and the conveyor names it by the issue number: GitHub `github.com/owner/repo/issues/51` and GitLab issue `#51` are task `51`.

- Commands take the bare number: `conveyor attach 51`, `conveyor release 51`. In a shell, `#51` starts a comment, so write `51`.
- Branches carry the number: `conveyor/51` (work), `conveyor-lock/51` (claim).
- Own identifiers, such as `US-E4-01`, can stay in the issue title; the conveyor ignores them.

## When a stage fails

- A failed stage (the agent returns `failed`, the process crashes, the stage or stall timeout hits, or the `before_run` hook fails) stops the chain: the next stage does not start. The task stays yours in `conveyor::in-progress`; the workpad shows "Last error" and the failed attempts; the status screen shows the task in red.
- The conveyor retries the same stage after 10 s, 20 s, 40 s, …, at most `retry.max_backoff` (5 min). After `retry.max_attempts` (5) it posts "The `<stage>` stage failed N times: <error>. Reply in a comment to retry." and sets `conveyor::needs-input`; the board notifies you.
- A configuration error (unknown model, missing skill, template error, unavailable harness) skips the retries and goes to `needs-input` at once with the fix to make.
- What to do: read the error, fix the cause, then reply in the issue with any comment; the next cycle runs the same stage again with fresh attempts. Alternatives: `conveyor attach <number>` to work it out with an agent, `conveyor release <number>` to hand the task over, or close the issue to cancel it.
- If `conveyor run` itself stops, the task stays in `in-progress` and continues on the next start; when its heartbeat is older than `timeouts.heartbeat` (default 30m), another workstation may release and take it (not tasks with private artifacts).

## Setup

1. Install: `npm install -g @phalbohr/conveyor`; sign in `gh` or `glab`; install the harness CLIs your stages use.
2. In the repository: `conveyor init` (reads the board from `git remote origin`). Commit `.conveyor/` except `local.yaml`.
3. Each member: `conveyor settings` → Personal (limits, chat language), then `conveyor skill install` for agent help.
4. Board columns (once, by a human): `init` and every start create the `conveyor::*`, `form::*`, and `stage::*` labels; columns are Backlog, Needs input, Queued, In progress, Review, Done. GitHub: create a project, `conveyor config set board.github_project <number>`, start the conveyor (it adds the field `Conveyor`), then choose `Conveyor` under "Column by" in a Board view. GitLab: Issues → Boards, one list per label: `conveyor::backlog`, `needs-input`, `queued`, `in-progress`, `review`, `done`.

## Team settings

- Team settings are the committed files in `.conveyor/`; change them on a branch and merge them through a pull request like code. `local.yaml` stays personal.
- `conveyor run` reads the settings from your working copy and reloads them every cycle; changes to `harnesses` need a restart of `run`.
- Newer team settings: `conveyor run` fetches `origin` every cycle and warns once when the main branch has commits in `.conveyor/` that your branch lacks; the status screen shows the same notice. Run `git pull` to take them. Your own uncommitted or unpushed changes never trigger it.
- Settings outside the repository (`init --path`) belong in a shared git repository; members link it with `conveyor init --use <dir>`.

## Daily use

| I want to … | Do |
|---|---|
| see my tasks, limits, subscription windows | `conveyor` (control screen; `h` help, `u` usage): each of my tasks with its state, current stage, retries, and errors; on the board the `stage::<name>` label shows the same |
| start working the board | `s` on the control screen (`o` shows the log), or `conveyor run` (opens the control screen already running; without a terminal it prints the log). Stopping (`s` again, `q`, or Ctrl+C) aborts running stages; tasks resume on the next start. Log file: `~/.conveyor/logs/<project>.log` |
| use everything from one place | `conveyor` (full-screen; `↑` `↓` scroll help, usage, and log): `s` start/stop, `o` log, `u` usage, `n` new, `a` attach, `l` release, `e` settings |
| add a task | `conveyor new` (the agent shapes an idea, a story, or a story with a plan; with a prepared story, ask it for the plan and the task starts with implementation), or an issue with `conveyor::backlog` and `form::idea`, `story`, or `plan` (a draft without a form is ignored) |
| answer a question | reply in the issue, or `conveyor attach <number>` |
| approve a reviewed task | `/approve` on the issue or the pull request, or an Approve review; on GitLab `/approve` in the MR is GitLab's own approval and counts too. Never write `/merge` in a GitLab MR: that quick action merges at once, past the conveyor |
| request small fixes | `/fix <notes>` reruns from `plan` (the plan stage adapts the plan to your notes, then the later stages run) or `/fix_from: <stage> <notes>`, e.g. `/fix_from: implement`, to skip the plan; branch and pull request stay |
| start over | `/rework <notes>` or the label `conveyor::rework`; new branch from `plan` on |
| give a task back | `conveyor release <number>` (`--force` for private tasks of others) |
| change settings | `conveyor settings`, or `conveyor config list|get|set`, `conveyor config stage add|remove|move`. In the editor, help follows the chosen option; `(defaults: claude)` shows the value a stage takes from `defaults`; switching a harness drops options the new harness does not take and picks a model and effort it lists; a yellow "Not valid yet" block names what blocks saving. Switching to a harness other than claude drops `permission_mode`; to one other than codex drops `sandbox` and `network`; the model stays when the new harness lists it, otherwise it becomes the first listed model; the effort becomes `medium` when listed, otherwise the first listed effort; a harness without a model list gets a text field |

## Files and what they control

| File | Controls |
|---|---|
| `config.yaml` (team) | board, `pickup_from`, `transitions`, `stages`, `defaults`, `triage`, `harnesses`, `artifacts`, `hooks`, `timeouts`, `retry`, `merge_method`, `close_on_done`, `review.approvals`, `language.docs` |
| `local.yaml` (personal) | `limits` (running, awaiting_me, awaiting_review, daily_tokens, subscription reserves), `poll_interval`, `pickup`, `workspace.root`, `language.chat`, personal `harnesses` overrides, private `artifacts` |
| `stages/<name>.md` | what a stage does: Liquid template with `issue`, `stage`, `attempt`, `artifacts`, `review`, `language`, `formats`; frontmatter `skills: [a, b]` attaches skills (claude stages) |
| `smart/<gate>.md` | when a smart gate asks a human (`idea-story`, `story-plan`, `merge`) |
| `live/new.md`, `live/attach.md` | instructions for the live sessions |
| `formats/story.md` | the story structure |
| `triage.md` | how triage orders tasks |

`conveyor config list` describes every key that `conveyor config set` can change.

## Concepts

- **Gate modes**: `interactive` (questions and approval), `autonomous` (no questions), `smart` (asks only by the criteria in `smart/<gate>.md`).
- **Stages**: ordered list in `config.yaml`. `story`, `plan`, and `merge` are reserved; custom stages go after `plan`, before or after `merge`. Remove the line of a custom stage to drop it (the reserved stages always stay); add `review-2` with another harness for a second reviewer. Every stage, custom ones included, gets its `stage::<name>` label on the next `init` or start.
- **Stage files**: every stage needs its instructions in `stages/<name>.md`. Adding a stage through `conveyor settings` or `conveyor config stage add` creates a stub there. A configured stage whose file is missing, empty, or still the stub has no description: `conveyor run`, the status screen, and the settings editor warn about it. The settings editor's "Stage files" section lists every stage and every file in `stages/` with on/off; switching a file on adds the stage before `merge`, switching it off removes the stage from `config.yaml` and keeps the file.
- **Trust**: the conveyor takes only tasks whose author has write access to the repository (GitHub: write, maintain, admin; GitLab: Developer or higher). Comments, reviews, `/approve` and other commands, replies, workpads, and artifacts from other users are ignored. Copy an outside contributor's issue into a new issue to run it.
- **Agent permissions**: claude stages run with `permission_mode: bypassPermissions` by default; `auto`, `acceptEdits`, or `dontAsk` limit the tools, and the allow rules come from the repository's `.claude/settings.json`. Codex stages run in `sandbox: workspace-write` with `network: false` by default.
- **Secrets**: everything the conveyor itself writes to the board, the artifacts it commits, and its log replace known token formats and the values of 8 or more characters of variables whose names contain `TOKEN`, `SECRET`, `PASS`, `KEY`, or `CREDENTIAL` (from the environment and from `harnesses.*.env`) with `[redacted]`; error comments also replace the home path with `~`. Code the agent commits and anything the agent posts itself (for example with `gh`) is not checked. Details and limits: `SECURITY.md`.
- **Harnesses**: `claude` and `codex` are built in; `opencode`, `kilocode`, `pi`, `openhands`, and `agent-zero` are presets in `config.yaml` under `harnesses`. Command harnesses get the model key from their own configuration (for OpenCode `{env:NAME}` in `opencode.json`); start the conveyor from a shell where that variable is set, and give it a name with `KEY` or `TOKEN` so the conveyor hides its value on the board. Any CLI works with `command`, `args`, and `env`; placeholders `{prompt}`, `{model}`, `{effort}`, `{workspace}`, `{result}`.
- **Models**: the `model` value goes to the harness as is. Claude takes aliases (`opus`, `sonnet`, `haiku`, `fable`: always the newest version) or full names (`claude-opus-5-5`, `claude-opus-5`); pin a full name in the team config for stable behavior. `conveyor models [harness]` lists the models and efforts of a harness: Claude from its own model menu (the same list as `/model`, with versions, names, aliases, and efforts per model; aliases stay valid), Codex from `codex debug models`, OpenCode from `opencode models` (includes self-hosted providers from `opencode.json`), Pi from `pi --list-models`, any harness from its `models: {command, args}` setting (for example a LiteLLM `/v1/models` query); `--refresh` asks again. The settings editor offers these lists (`←` `→`, Enter, `other…` for any name, `m` to refresh). `conveyor run` warns at start about a model a harness does not list; a stage whose harness rejects the model goes to a human at once without retries.
- **Limits** (personal): the conveyor claims a new task only while the tasks this workstation runs (`limits.running`; the control screen shows my tasks in progress), my tasks in needs-input without an answer (`limits.awaiting_me`), my tasks in review (`limits.awaiting_review`), daily tokens, and subscription reserves are all below their limits. The control screen shows them as `my status: in progress 1/3 · needs input 0/5 · review 2/2` (`←` `→` select a column, Enter lists its tasks); a full limit turns the line yellow. `u` opens the usage view: tokens today against `limits.daily_tokens`, and one line per harness in use: its 5h and 7d subscription windows with use and reserve (claude and codex), "not seen yet" until its first stage or a probe (`limits.subscription.probe`), or "does not report" for command harnesses such as opencode. When the daily limit or a subscription reserve stops new tasks, the main screen shows a yellow `no new tasks: … reached · [u] usage` line. Answered tasks resume before new ones.
- **Timeouts**: stage and stall timeouts (`timeouts.stage`, at least 1m; `timeouts.stall`, 0 or at least 1m) retry with backoff up to `retry.max_backoff`; after `retry.max_attempts` the task asks a human. A running task writes a heartbeat every third of `timeouts.heartbeat` (default 30m, at least 1m); another workstation releases a claim whose heartbeat is older, or one that waited longer than `timeouts.waiting` (default 4d, at least 1d). A shorter heartbeat timeout lets workstations take over tasks that still run, so the settings reject values below 1m. A lock left by a crashed workstation is removed when a workstation sees it for 10 minutes: `conveyor-lock/<number>` of a task without an owner label, `conveyor-lock/merge`, and `conveyor-lock/triage` (after `timeouts.stage` plus 10 minutes). `conveyor release <number>` removes the lock of a task without an owner at once.

## Recipes

**A stage on a self-hosted model through LiteLLM (OpenCode):**
1. Add a provider, for example `litellm`, to OpenCode's global `~/.config/opencode/opencode.json` (or `opencode.json` in the repository) with `"npm": "@ai-sdk/openai-compatible"` and `"options": {"baseURL": "http://localhost:4000/v1", "apiKey": "{env:LITELLM_API_KEY}"}`; keep the key in that variable, not in the file. Kilo Code uses the same format in `~/.config/kilo/kilo.jsonc`.
2. `conveyor config set stages.implement.harness opencode` (or `kilocode`), then `conveyor config set stages.implement.model litellm/<model>`; `conveyor models opencode` (or `kilocode`) lists the names.

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
