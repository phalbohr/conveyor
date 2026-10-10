# Conveyor — Design

A configurable development conveyor. Tasks live on a kanban board (GitHub or GitLab). Agents from different harnesses move each task through stages up to merge and beyond. Several workstations run at the same time.

## Principles

1. One run advances a task to the next gate and stops. Gates: a question to a human, approval of a result, merge.
2. The board holds task state, not the process. Any authorized workstation can continue a task.
3. The orchestrator is deterministic. Agents make decisions inside stages; the CLI controls stage order and transitions.
4. Limits are personal. Each workstation counts only its own tasks.
5. Agents never write to the board. A stage returns a structured result; the CLI writes labels, comments, and artifacts. The harness process never receives the board credential.

## Components

| Component | Responsibility |
|---|---|
| CLI `conveyor` (TypeScript + Ink) | init, settings TUI, board polling, task claim, stage execution, limits and token accounting |
| Board adapters | `github` via `gh`, `gitlab` via `glab`: labels, comments, links, branches, PR/MR. The GitLab adapter reads tasks and open blockers with one GraphQL query, retries transient network errors (reads always, writes only when the connection was not established), and falls back to a `Blocked by: #N` line in the description on GitLab Free. |
| Harness adapters | `claude`, `codex`, more later: run a stage, enforce the stage result schema, collect token usage |
| Workspace manager | one git worktree per task, lifecycle hooks, cleanup of closed tasks |
| Templates | default `stages/*.md`, `smart/*.md`, `triage.md`, copied on init |

## Entry point

`conveyor` looks for `.conveyor/` in the working directory. If it is missing:

1. initialize a project in the current directory;
2. initialize a project at a given path;
3. point to existing settings.

Commands:

| Command | Action |
|---|---|
| `conveyor` | settings TUI |
| `conveyor run` | work loop: poll the board, claim tasks within limits |
| `conveyor new` | live dialog in the terminal; result is a new task on the board |
| `conveyor attach <issue>` | answer the questions of a `needs-input` task in the terminal |
| `conveyor release <issue>` | release the task claim manually |

## Language and formats

- `language.docs` in `config.yaml` is the team language for everything the team sees: artifacts, issue bodies, questions and approval requests on the board, the workpad, and the results of live sessions. Default: English.
- `language.chat` in `local.yaml` is the personal language for live sessions. Default: the language the human uses.
- `formats/story.md` holds the story structure (actors, story, current problem, main and alternative scenarios, acceptance criteria in Given/When/Then, dependencies, and writing rules). The `story` stage and `conveyor new` use it through the template variable `formats.story`.
- Stage templates get the variables `language.docs` and `formats.story`.

## Team settings sync

- Team settings travel through git like code. Each workstation runs with the settings of its working copy.
- Every `run` cycle fetches `origin` and lists commits on the base branch (`origin/<board.base_branch>`, else the default branch of the repository) that touch the settings directory and are missing from `HEAD`. A non-empty list gives one warning per new list in the log and a warning line on the status screen (which fetches at most every 5 minutes). The conveyor never pulls on its own.
- Settings outside git, or without `origin`, skip the check.

## Live sessions

- `conveyor new`, `conveyor attach <issue>`, the task harness session (`h` on a task), and the help session (`a` on the help screen) start a normal interactive session of a harness in the terminal. All of them use the personal `live: {harness, model, effort}` from `local.yaml`; a missing value comes from `defaults`.
- `claude` and `codex` start with `--model` and the effort; a command harness starts with its `interactive` args (placeholders `{prompt}`, `{model}`, `{effort}`, `{workspace}`). The `opencode` and `kilocode` presets have `interactive: [--model, "{model}", --prompt, "{prompt}"]`; a harness without `interactive` cannot run live sessions, and the CLI says so. A session that exits with a non-zero code reports the code and points to `live.harness` and `live.model`.
- The session instructions are strict templates in `live/new.md` and `live/attach.md` (package defaults if missing). The agent writes its result to a temporary file; the CLI reads it after the session ends and writes to the board.
- `new`: the result has frontmatter `title` and `form` (`idea`, `story`, or `plan`) and the task text. The CLI creates the task with `conveyor::backlog` and that `form::` label.
- `attach`: the result is the decision of the human. The CLI posts it as a normal comment without the agent marker, so the next `run` cycle resumes the stage.
- The session environment has no board credentials. Interactive sessions use the full personal setup of the harness, because a human supervises them.

## Settings layout

```
.conveyor/
  config.yaml          team settings, committed
  local.yaml           personal settings, gitignored
  stages/<stage>.md    stage instructions: text, a skill reference, or other
  smart/<gate>.md      criteria for smart mode
  triage.md            triage instructions
  live/new.md          instructions for `conveyor new`
  live/attach.md       instructions for `conveyor attach`
  formats/story.md     story structure for the story stage and `conveyor new`
```

### config.yaml

```yaml
board:
  provider: github                 # github | gitlab
  project: owner/repo
artifacts:
  idea:  {store: board}            # board | repo | path
  story: {store: board, write: replace}   # replace | append
  plan:  {store: repo, path: docs/plans, allow_private: true}
pickup_from: story                 # idea | story | plan
transitions:
  idea_to_story: smart             # interactive | autonomous | smart
  story_to_plan: interactive
  merge: human                     # human | ai | smart
defaults: {harness: claude, model: sonnet, effort: medium}
triage:   {harness: claude, model: opus, effort: high}
stages:                            # key order = execution order
  story:      {harness: claude, model: opus,   effort: high}
  plan:       {harness: codex,  model: <codex-model>, effort: high}
  implement:  {harness: claude, model: sonnet, effort: medium}
  review:     {harness: claude, model: opus,   effort: high}
  review-2:   {harness: codex,  model: <codex-model>, effort: high}
  merge:      {harness: claude, model: haiku,  effort: low}
  fix-ci:     {harness: claude, model: sonnet, effort: high, when: failure}
hooks:                             # shell scripts, run in the task workspace
  after_create: npm ci
  before_run: ""
  after_run: ""
  before_remove: ""
  timeout: 60s
timeouts:
  stage: 60m                       # maximum duration of one stage run
  stall: 5m                        # maximum time without harness events; 0 = off
  heartbeat: 30m                   # active states only: stale claim release
  waiting: 4d                      # waiting states: 4d calendar days or 2wd working days
retry:
  max_backoff: 5m
  max_attempts: 5
```

### local.yaml

```yaml
artifacts:
  plan: {store: path, path: "~/Plans/{project}"}   # allowed only if allow_private: true
limits:
  running: 3             # tasks executing at the same time
  awaiting_me: 5         # tasks in discussion, waiting for my answer
  awaiting_review: 2     # tasks waiting for my code review
  daily_tokens: 0        # 0 = no limit
poll_interval: 5m
pickup: {assignee: me, include_unassigned: true}
workspace: {root: "~/.conveyor/workspaces/{project}"}
```

## Artifacts

- Each artifact (idea, story, plan) has its own storage: `board`, `repo` (file in the project repository, committed on the task branch), `path` (any local directory, also outside the repository).
- On the board, idea and story live in the issue body; plan and custom artifacts live in one agent comment per kind, updated in place.
- Files in `repo` and `path` storage are named `<issue>-<kind>.md`.
- `write: replace` overwrites the previous artifact text in place (idea → story in the same issue body). `write: append` adds to it.
- Private artifacts: the team allows them with `allow_private: true`. A member then overrides the storage in `local.yaml`. A private artifact is visible only to its owner.
- A task always has an owner (`claimed-by`). A task with a private artifact is never released automatically. Only the owner can continue it, unless it is released manually (a non-owner needs `--force`).

## Stages

- `stages` is an open ordered list. Remove a line to disable a stage. Several reviewers are several lines (`review`, `review-2`, ...).
- Reserved stages: `story`, `plan`, `merge`. They are bound to `pickup_from` and `transitions`.
- Custom stages (`optimize`, `polish`, `fix-ci`, ...) have any name and their own harness, model, and effort. Missing values come from `defaults`.
- Allowed positions of custom stages: between `plan` and `merge`, and after `merge`.
- Post-merge stages have `when: success | failure | always` (default `success`, as `on_success` in GitLab CI). Example: `fix-ci` runs only if merge or the pipeline failed.
- Init creates `stages/<stage>.md` for each stage; adding a stage later creates a stub file. A configured stage without a description (missing file, empty body, or the unchanged stub) gives a warning in `run`, on the status screen, and in the settings editor. Stage files that are not in `config.yaml` are listed as switched off and never warned about.
- Stage files are strict templates. Variables: `issue` (id, title, body, labels, comments, blockers), `stage`, `attempt` (null on the first run), `artifacts` (idea, story, plan), `review` (feedback on rework). An unknown variable fails rendering; the stage does not start.

## Stage skills and isolation

- Harness sessions run isolated: no personal settings, plugins, hooks, or MCP servers (claude: `--setting-sources project,local --strict-mcp-config`). Behavior is the same on every workstation, and each call costs less.
- A stage file declares the skills it needs in its frontmatter:

  ```markdown
  ---
  skills: [brainstorming, grilling]
  ---
  Write the story from the idea. Use the grilling skill to clarify requirements.
  ```

- Before the stage runs, the CLI makes exactly these skills available in the session. `config.yaml` describes resources (harness, model, effort); stage files describe behavior and its dependencies.
- Skill lookup order, first match wins (as in Claude Code):
  1. the project's `.claude/skills/`;
  2. personal skills in `~/.claude/skills/`;
  3. installed plugins, by name `plugin:skill`.
- A missing skill blocks the stage with an error that names the skill and the stage. The stage never runs without a declared skill.
- `conveyor run` checks the frontmatter of all configured stages once at start, so a missing skill shows up at once and not hours later.
- For teams, skills belong in the repository (committed copies) or in a plugin. Symlinks to personal paths break on other workstations.
- The claude adapter attaches personal skills through `--add-dir` (names stay unchanged) and plugin skills through a temporary plugin with the same name (`plugin:skill` stays unchanged). Skills are supported only for claude stages for now.

## Stage result contract

Every stage returns one structured result. The harness adapter enforces the schema with the harness's native support (for example an output schema flag); otherwise it validates the final JSON block.

```yaml
outcome: done | needs_input | approval | failed
summary: string
artifact: {kind: idea | story | plan | <custom>, content: string}   # optional
questions: [string]                                                 # with needs_input
workpad: string                                                     # markdown, replaces the workpad
```

The CLI maps the result to board writes:

| Outcome | CLI action |
|---|---|
| `done` | store the artifact, update the workpad, continue with the next stage |
| `needs_input` | post the questions, set `conveyor::needs-input`, stop |
| `approval` | store the artifact, post an approval request, set `conveyor::needs-input`, stop |
| `failed` | record the error in the workpad, schedule a retry |

## Workpad

- Each task has one agent comment, the workpad. The CLI creates it on claim and replaces its body after each stage.
- Sections: plan, checklist, validation, notes, open questions.
- Questions to humans and approval requests are separate comments, so the board sends notifications. All other agent output goes to the workpad.
- The workpad update time is the heartbeat. During a long stage the CLI refreshes it at a fixed interval.
- `triage` is not a task stage. It is a loop action that orders tasks and sets dependencies. It runs at the start of a `run` cycle when the board has new tasks.

## Pickup point

`pickup_from` is a single value. The sets are cumulative:

| Value | Tasks the conveyor takes |
|---|---|
| `plan` | only tasks with a plan |
| `story` | tasks with a plan, and stories without a plan |
| `idea` | all tasks, starting from an idea |

## Transition modes

| Mode | Questions during work | Approval of result |
|---|---|---|
| `interactive` | yes | yes |
| `smart` | if data is missing, per `smart/<gate>.md` | per `smart/<gate>.md` |
| `autonomous` | no | no |

Merge:

| Mode | Behavior |
|---|---|
| `human` | the task always goes to a human for review |
| `ai` | the agent merges |
| `smart` | the agent decides per `smart/merge.md` |

Dialog channels:

- primary: comments on the board; agent comments carry the marker `<!-- conveyor -->`;
- live: `conveyor new`, `conveyor attach <issue>`.

A comment without the marker after an agent question is the answer. The task goes back to the queue without an explicit command.

## Board states

| Label | Meaning |
|---|---|
| `conveyor::backlog` | waits for humans or for the conveyor; only tasks with a `form::` label are taken |
| `form::idea`, `form::story`, `form::plan` | the task is ready in this form; the conveyor removes it when it takes the task |
| `conveyor::needs-input` | waiting for a human answer |
| `conveyor::queued` | answer received, waiting for a free slot |
| `conveyor::in-progress` | a stage is running; `stage::<name>` shows which one |
| `conveyor::review` | waiting for code review |
| `conveyor::rework` | a human signal: the task restarts after `plan` |
| `conveyor::done` | merged and post-merge stages complete |
| `stage::<name>` | the running or waiting stage; removed at review and done |

GitHub Projects: on GitHub the board with columns is a GitHub project, a required part of the setup. `conveyor init` and `conveyor board update` use the project linked to the repository (`repository.projectsV2`), or create one and link it when none is linked, and write `board.github_project`; with several linked projects the user chooses. The CLI adds every task to the project and mirrors its state to the single-select field `Conveyor` (one option per state) on every state change and on a sync every cycle. The standard `Status` field stays untouched. The Board layout and "Column by: Conveyor" are chosen once by hand; GitHub has no API for views. A GitHub board without `board.github_project` is reported by the board check.

## Board upgrades

`conveyor init` creates the labels and, with `board.github_project`, the `Conveyor` field. Later versions may need new labels or options. The conveyor never applies such changes on its own:

- every start, the status screen (every 5 minutes), and `conveyor board check` compare the board with this version: missing labels, a missing `Conveyor` field or missing options, `conveyor::`, `form::`, and `stage::` labels this version does not use, and open tasks that carry them;
- `conveyor board update`, or `k` and Enter on the control screen, adds missing labels, the missing field, and missing options of an existing field after the user asks for it; options go in through GitHub's `updateProjectV2Field` with the ids, colors, and descriptions of the existing options, so they and the card values stay;
- nothing existing is changed or deleted: unused labels and old labels on open tasks are reported for manual cleanup; closed tasks are not checked;
- during normal work the conveyor never creates the field: a missing field only produces a warning.

## Parts

The stage result has `parts`: the plan stage returns the ordered titles of the parts when the work needs several pull requests that merge one after another, otherwise null. The workpad keeps `parts` and the index `part` of the current one.

- The stages after `plan` work on the current part; the prompt lists all parts, marks the merged ones, and names the current one.
- The pull request title is `<task title> (part k/n: <part title>)`; the card has the label `part::k/n`.
- After part k merges and its post-merge stages run, the conveyor resets the task branch to the updated base branch, moves the task back to the first stage after `plan` for part k+1, and leaves it in `conveyor::in-progress`. Every part has its own review and approvals.
- A rerun of `plan` (for example `/fix_from: plan`) keeps the merged parts and replaces the remaining ones with the parts it returns.
- After the last part the task is done and the `part::` label is removed.

## Task claim

1. The CLI pushes a new lock branch `conveyor-lock/<issue>`. The server rejects the push if the branch exists. This operation is atomic.
2. Push accepted: the CLI sets `conveyor::in-progress` and `claimed-by::<user>`.
3. Push rejected: another workstation has the task; the CLI takes the next one.
4. The work branch `conveyor/<issue>` is separate from the lock branch. A release deletes only the lock branch, so the next owner continues the work.

Release deletes the lock branch, removes `claimed-by::<user>`, and posts a comment with the reason. The task keeps its state label. Releases happen in three cases:

| Case | Condition |
|---|---|
| Stale heartbeat | active state (`in-progress`) and no workpad update for `timeouts.heartbeat` (default 30m) |
| Waiting timeout | waiting state (`needs-input`, `queued`, `review`) for longer than `timeouts.waiting` (default `4d`) |
| Manual | `conveyor release <issue>` |

- The heartbeat timeout never applies to waiting states: a task that waits for a human has no heartbeat.
- The waiting time counts from the moment the task entered the waiting state. The CLI records this moment in the workpad.
- `timeouts.waiting` accepts calendar days (`4d`) or working days (`2wd`, Monday to Friday; holidays are not counted).
- Automatic releases skip tasks with private artifacts. Manual release of such a task by a non-owner requires `--force`, because the next owner cannot read the private artifacts.
- `conveyor release <issue>` on a task that runs on this workstation stops the harness first.

## Candidate order

1. Tasks from the resume queue.
2. Tasks assigned to me, then unassigned tasks (if enabled).
3. Inside each group: priority ascending (null last), then creation time (oldest first), then identifier.

Priority comes from the adapter: a GitHub Projects field, a `priority::<n>` label, or GitLab weight. Triage sets it.

## Cycle

Each `run` cycle runs these steps in order:

1. Reconcile running tasks.
2. Reload and validate the configuration.
3. Triage, if the board has new tasks.
4. Claim and start tasks within limits, in candidate order.

If the configuration is invalid, steps 3 and 4 are skipped; reconciliation still runs. Running stages keep the configuration snapshot they started with.

## Reconciliation

At the start of each cycle the CLI re-reads every task it runs:

| Board state | Action |
|---|---|
| closed | stop the harness, remove the workspace, release the claim |
| `conveyor::*` state removed, or owner changed | stop the harness, keep the workspace, release the claim |
| still active | update the task snapshot |

If the board read fails, running stages continue; the next cycle tries again.

## Timeouts and retry

- `timeouts.stage` limits one stage run. `timeouts.stall` limits the time without harness events. On a timeout the CLI stops the harness and schedules a retry.
- A retry also follows a `failed` outcome and a harness crash.
- Delay: `min(10s * 2^(attempt - 1), retry.max_backoff)`.
- After `retry.max_attempts` the task gets `conveyor::needs-input` with the error in the workpad.
- The attempt number is available to the stage template as `attempt`.

## Workspaces and hooks

- Each task has one git worktree under `workspace.root`, on the branch `conveyor/<issue>`. Stages of the task run in it.
- The base branch is `board.base_branch`, else the default branch of the repository from the board API. It is the one source for the start of a task branch (`origin/<base>`, or the existing `origin/conveyor/<issue>`), the reset on rework and between parts, the target of pull/merge requests, the start of lock branches, and the settings sync check. The conveyor pushes only `conveyor/<issue>` and lock branches; the base branch changes only through merged pull/merge requests.
- Hooks run in the workspace with `hooks.timeout`:

| Hook | When | On failure |
|---|---|---|
| `after_create` | the workspace is new | workspace creation fails |
| `before_run` | before each stage run | the run fails |
| `after_run` | after each stage run, any outcome | logged, ignored |
| `before_remove` | before workspace removal | logged, removal continues |

- On start, `conveyor run` removes workspaces of closed tasks.

## Limits and queue

- `running` is counted in the `conveyor run` process. A pid file in `~/.conveyor/run/` allows only one `run` process per project on a workstation.
- Daily token usage is stored in `~/.conveyor/usage/<project>.json`.
- Subscription reserve (`local.yaml`): `limits.subscription.five_hour_reserve` and `seven_day_reserve` in percent (0 = off). The claude adapter reads the utilization of both windows from the rate limit events of every run; the codex adapter reads them from the session file of the run (`$CODEX_HOME/sessions/…/rollout-…-<thread>.jsonl`, the `rate_limits` of the last `token_count` event: the 300-minute and 10080-minute windows) and deletes the file afterwards. Command harnesses report no windows. If a window of a harness has less than its reserve left, no stage of that harness starts until the window resets: the task waits without losing an attempt, and no new tasks are claimed. A running stage is never interrupted.
- The conveyor only sees its own runs. `limits.subscription.probe: true` adds a cheap run per harness (claude: haiku, codex: gpt-6-luna; low effort) when the last reading is older than 10 minutes, to see usage from interactive sessions too.
- A confirmed task leaves `awaiting_me`. If no `running` slot is free, it gets `conveyor::queued` and waits.
- When a slot is free: first tasks from the resume queue, then new tasks from the board.
- `awaiting_review` only blocks the claim of new tasks. It never stops a task that is ready for review.
- The CLI claims a new task only if all conditions are true:
  - `running < limits.running`;
  - `awaiting_me < limits.awaiting_me`;
  - `awaiting_review < limits.awaiting_review`;
  - the resume queue is empty;
  - the daily token limit is not reached (if enabled).

## Merge and dependencies

After the `merge` stage the CLI pushes the task branch and opens a pull request. The body has no closing keyword (`Closes #N`), so GitHub does not close the issue on merge; the CLI closes it when the task is complete.

| Merge mode | After the merge stage |
|---|---|
| `human` | the task goes to `review`; a human reviews and merges the pull request |
| `ai` | the CLI lands the pull request |
| `smart` | the merge stage returns `approval` (review needed, by `smart/merge.md`) or `done` (land) |

Landing is a deterministic CLI step, retried every minute while it waits:

1. Open blockers → wait (dependency order).
2. Checks pending or mergeability unknown → wait.
3. Checks failed, conflicts, or merge error → run post-merge stages with `when: failure` or `always` (for example `fix-ci`), then land again. Without such stages, or after `retry.max_attempts` landing failures, the task goes to `needs-input`.
4. Otherwise take the lock `conveyor-lock/merge`, merge with `merge_method` (`merge`, `squash`, `rebase`; default `merge`), release the lock.
5. Success → post-merge stages with `when: success` or `always` → `conveyor::done`: the CLI closes the issue only with `close_on_done: true` (default `false`: a human closes it after acceptance), deletes the claim lock, the workspace, and the merged task branch.

In `review` the CLI checks every cycle for signals since the task entered `review`, on the pull request and on the issue:

| Signal | Action |
|---|---|
| the pull request is merged by a human | post-merge stages, then `done` |
| a comment starting with `/rework` | rework: close the pull request, reset the branch, restart after `plan` |
| a "Request changes" review or a comment starting with `/fix` | fix on the existing branch from the `plan` stage; the pull request stays open |
| a comment `/fix_from: <stage>` | fix on the existing branch from the named stage (`plan` … `merge`) |
| enough distinct approvers: "Approve" reviews plus authors of comments starting with `/approve` | landing |

- The text after a command and the review comments become the feedback for the stages. Fix and rework keep the plan artifact; fix also keeps the workpad.
- Precedence: `/rework` > `/fix_from` > `/fix` > approvals.
- Only reviews and comments after the task entered `review` count, so a stale "Request changes" does not trigger a fix loop.
- An unknown stage in `/fix_from` gets one error comment with the allowed stages; the command is then ignored.
- `review.approvals` in `config.yaml` sets the number of distinct approvers (default 1).
- Comments count because GitHub does not let the author approve their own pull request, and pull requests are opened with the personal token.
- Branch protection on GitHub (required reviews, required checks) still applies: if it rejects the merge, the task goes to the failure path.

## Triage

- Runs at the start of a cycle when unclaimed tasks in `idea`, `story`, or `plan` have no priority.
- One workstation at a time: lock `conveyor-lock/triage`.
- The agent gets all open conveyor tasks (title, state, priority, the start of the body) with new tasks marked. It returns JSON: a priority 1–4 per new task and `blocked_by` lists. The CLI sets `priority::<n>` labels and native "blocked by" links.
- New tasks the agent left out get priority 3, so the triage does not repeat every cycle.
- A failed triage waits `retry.max_backoff` before the next attempt. No triage runs over the daily token limit.

## Rework

- Trigger: the PR/MR review has "changes requested", or a human sets `conveyor::rework`.
- The task restarts: the CLI closes the PR/MR, resets the branch `conveyor/<issue>` to the base branch, and clears the workpad.
- Execution starts again at the first stage after `plan`. The template variable `review` holds the review feedback.
- A stage may return `needs_input` if the plan must change.

## Harnesses

| Harness | Invocation |
|---|---|
| `claude` | `claude -p --model <m> --effort <e> --output-format stream-json` |
| `codex` | `codex exec -m <m> -c model_reasoning_effort=<e> --json` |

Other harnesses run through a generic command adapter. Built-in presets:

| Harness | Command | Model endpoint |
|---|---|---|
| `opencode` | `opencode run --auto -m {model} --dir {workspace} {prompt}` | custom provider in `opencode.json` (`@ai-sdk/openai-compatible`, `baseURL`) |
| `kilocode` | `kilo run --auto -m {model} --dir {workspace} {prompt}` | custom provider in `~/.config/kilo/kilo.jsonc`, same format as OpenCode |
| `pi` | `pi --mode json --model {model} --thinking {effort} -- {prompt}` | provider in `~/.pi/agent/models.json` (`api: openai-completions`, `baseUrl`) |
| `openhands` | `openhands --headless --override-with-envs --json -t {prompt}` with `LLM_MODEL={model}`, `OPENHANDS_WORK_DIR={workspace}` | `LLM_BASE_URL`, `LLM_API_KEY` in `env` |
| `agent-zero` | `a0 headless -p {prompt} --output jsonl --workspace {workspace}` | model set in the Agent Zero instance; host in `AGENT_ZERO_HOST` |

- `harnesses` in `config.yaml` defines new harnesses or overrides presets (`command`, `args`, `env`); `harnesses` in `local.yaml` overrides personal values such as the endpoint or the key. `env` merges, `command` and `args` replace.
- Placeholders in `args` and `env`: `{prompt}`, `{model}`, `{effort}`, `{workspace}`, `{result}`, `{temp}` (a temporary directory of the run, deleted after it).
- The `opencode` preset sets `OPENCODE_DB: {temp}/opencode.db` and the `kilocode` preset `KILO_DB: {temp}/kilo.db`: both keep one SQLite database per user, and parallel runs on it fail with "database is locked". Each stage gets its own database; live sessions keep the user's own.
- Live sessions use `interactive` instead of `args` and skip `env` values with `{result}` or `{temp}`.
- Result contract: the CLI appends the result schema to the prompt and asks the agent to write the result JSON to the file in `CONVEYOR_RESULT`. No result file means a failed stage.
- Every output line counts as a progress event for stall detection. Token usage and subscription windows are not available; self-hosted models use the daily token limit of their router.
- The presets come from the tools' documentation and are not yet verified with real runs.
- Model catalogs: claude from the `initialize` control request in stream-json mode (the `/model` menu: versioned ids, names, aliases, efforts per model; no tokens spent), codex from `codex debug models` (efforts per model), other harnesses from `models: {command, args}` in their definition (one model per output line) and `efforts` from the definition. Catalogs are cached per project in `~/.conveyor/models/<project>.json`. `run` warns about models outside a catalog; a stage failure that names an unknown or unsupported model is a configuration error and goes to a human without retries.

Codex stages accept two options:

| Option | Values | Default |
|---|---|---|
| `sandbox` | `workspace-write`, `full-access` | `workspace-write` |
| `network` | `true`, `false` (only with `workspace-write`) | `false` |

- In `workspace-write` codex cannot write to `.git` (verified on macOS), so the agent cannot commit. `full-access` removes the sandbox, like `bypassPermissions` for claude.
- In every mode the CLI commits the remaining workspace changes after each stage (`<stage>: <summary>`) and pushes the task branch.
- These options are an error on non-codex stages.

Claude stages accept `permission_mode`: `bypassPermissions` (default), `auto`, `acceptEdits`, `dontAsk`. Allow rules for the limiting modes come from the repository's `.claude/settings.json`. The option is an error on non-claude stages.

Stage instructions for `claude` can use Dynamic Workflows for parallel work (for example a reviewer panel). This is a stage capability, not the orchestration layer.

## Spike: Workflow in headless mode (2026-10-03)

Verified on Claude Code 2.1.288:

- `claude -p ... --allowedTools Workflow` runs a Workflow without interactive permission prompts;
- a script from any file via `scriptPath` works, so the CLI can ship its own scripts;
- `args` reach the script;
- per-`agent()` `model` works (haiku and sonnet in one run);
- the process waits for the workflow and emits two `result` events: the first after launch, the second with the outcome. Use the last one;
- overhead: about 58k context tokens per subagent caused by the user's global settings (CLAUDE.md, plugins, hooks). Harnesses must run with a minimal settings set.

## Prior art

[openai/symphony](https://github.com/openai/symphony) (Apache 2.0): a single-orchestrator daemon that runs Codex per tracker issue. Conveyor takes from it: reconciliation, stage and stall timeouts, retry with backoff, per-task workspaces with hooks, per-cycle config validation and reload, credential isolation (agents do not write to the board), the workpad comment, the rework flow, deterministic candidate order, and strict prompt templates. Conveyor differs: deterministic stages with per-stage harness, idea → story → plan with interaction modes, peer workstations with atomic claim, personal limits, triage and dependency-ordered merge.

## Delivery

1. Now: a single npm package with the CLI and the templates. `conveyor new` and `conveyor attach` start an interactive harness session in the terminal with the stage instructions.
2. Later: a Claude Code plugin in the same repository, published as a plugin marketplace. Its skills call `conveyor ... --json` and hold no own logic. Every CLI command supports `--json` from the start.
