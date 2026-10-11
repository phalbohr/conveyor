# conveyor

A configurable development conveyor. Tasks live on a GitHub or GitLab board. Coding harnesses (Claude Code, Codex, OpenCode, and others) move each task through stages — story, plan, implement, review, merge — and a human decides at the gates you choose. Several workstations can work on one board at the same time.

The full workflow, from an idea to a merged change, is in [skills/conveyor-help/workflow.md](https://github.com/phalbohr/conveyor/blob/main/skills/conveyor-help/workflow.md). The design is in [docs/design.md](https://github.com/phalbohr/conveyor/blob/main/docs/design.md).

After `conveyor skill install`, ask your harness (for example Claude Code) anything about the conveyor: it explains the workflow and settings and changes them for you.

## Status

Alpha (0.x). The configuration format and the board labels can change between minor versions; [CHANGELOG.md](https://github.com/phalbohr/conveyor/blob/main/CHANGELOG.md) lists every change. The `claude`, `codex`, `opencode`, and `kilocode` harnesses and the GitHub and GitLab boards are tested with real runs; the `pi`, `openhands`, and `agent-zero` presets are not yet.

Harnesses run as your user and, by default, without permission prompts. Read [Security](#security) before the first run.

## Requirements

- macOS or Linux. Windows is not supported.
- Node.js 22.12 or later, and git.
- GitHub (github.com; GitHub Enterprise is not supported yet): `gh`, signed in (`gh auth login`) with the `project` scope, because the board with columns is a GitHub project. `gh auth refresh -s project` adds the scope to an existing sign-in. With a classic personal access token, add the `project` scope to the token.
- GitLab: `glab`, signed in (`glab auth login`).
- The CLI of every harness your settings use, signed in. The default settings use `claude` (Claude Code) for every stage and for triage; `codex`, `opencode`, `kilo` (Kilo Code), `pi`, `openhands`, and `a0` are needed only when a stage uses them.

## Install

```bash
npm install -g @phalbohr/conveyor
```

## Quick start

```bash
cd your-repo
conveyor init
conveyor run
```

`conveyor init` reads the board from `git remote origin` and creates `.conveyor/`. A remote on `github.com` is GitHub; a remote whose host contains `gitlab` is GitLab. Pass `--provider github --project owner/repo` only when the conveyor cannot detect `origin`; in a terminal, `init` asks for the missing values. On GitHub `init` also sets up the board with columns: it uses the GitHub project linked to the repository, or creates and links one (with several linked projects it asks you to choose with `conveyor config set board.github_project <number>`, then `conveyor board update`), adds the `Conveyor` field, and writes `board.github_project`. To keep the settings outside the repository, use `--path <dir>`; to reuse existing settings, use `--use <dir>`.

Put a task on the board with the labels `conveyor::backlog` and `form::plan` (or `form::story` / `form::idea`, depending on `pickup_from`), or shape one in a live harness session:

```bash
conveyor new
```

### First run, step by step

1. In a repository whose `origin` is on GitHub or GitLab, run `conveyor init` and commit `.conveyor/`.
2. Create an issue yourself (the conveyor takes only tasks from users with write access) and add the labels `conveyor::backlog` and `form::plan`. Write the plan in the issue text.
3. Run `conveyor`: the [control screen](#control-screen) opens. Press `s` to start the conveyor; `o` shows its log.
4. The log shows `claimed task <number>` and each stage. The issue gets `conveyor::in-progress`, then a pull request opens and the issue gets `conveyor::review`.
5. Review the pull request. Write `/approve` (or approve it) to merge, `/fix <notes>` to fix on the same branch, or `/rework <notes>` to start over.

The task is not taken? Check that the issue has a `form::` label that `pickup_from` allows and the issue has no open blockers. The control screen shows your limits and the team queue with the owner of each task; its log (`o`) shows tasks skipped because their author has no write access. Every stage call costs tokens of the harness account; set `limits.daily_tokens` and the subscription reserves in `conveyor settings`. To stop, see [Control screen](#control-screen).

## Commands

| Command | What it does |
|---|---|
| `conveyor` | Opens the [control screen](#control-screen). Without a terminal it prints a text summary; `--json` prints the snapshot. Without settings it starts the init menu; Cancel or Esc leaves it and creates nothing |
| `conveyor init` | Creates settings (`--path <dir>` outside the repository) or links existing ones (`--use <dir>`); `--provider` and `--project` when `origin` is not detected |
| `conveyor settings` | Settings editor (also `e` on the control screen): team, stage, and personal fields; `↑` `↓` move, `←` `→` switch between the options of a field, Enter edits a value, `m` refreshes the model lists, `a` adds a stage, `x` removes it, `[` `]` move it, `s` saves after validation, `q` quits. Formatting and comments of the YAML files stay as they are |
| `conveyor run` | Works the board: claims tasks within your limits and runs their stages. In a terminal it opens the control screen with the conveyor already running; without a terminal (server, cron) it prints the log. `--once` runs one cycle. The log also goes to `~/.conveyor/logs/<project>.log` |
| `conveyor new` | Live harness session; creates a task with `conveyor::backlog` and `form::idea`, `form::story`, or `form::plan` (a story with your prepared plan). The conveyor may take it at once. `--write` opens a template in your editor (title, form `idea`/`story`/`plan`/`draft`, text); `--title "…" --form idea [--body "…"]` creates it at once. On the control screen `n` offers the same: `e` editor, `i` one-line idea, `h` live harness session |
| `conveyor attach <number>` | Live session to answer the questions of a waiting task; `<number>` is the issue number on the board, e.g. `51` |
| `conveyor release <number>` | Releases the claim of a task (`--force` for private tasks of others) |
| `conveyor reset <number> [--form idea\|story\|plan\|none]` | Starts a task over: stops its stage, closes its open pull request, deletes the branch `conveyor/<number>` and the workspace, clears the workpad and the `stage::` and `part::` labels, releases the claim, and returns the task to Backlog with a form you choose (default: the form the conveyor took it with; `none` leaves a draft). Merged parts stay in the base branch. Only the owner resets; while the conveyor runs, use `x` on its control screen |
| `conveyor config list` | Every setting with value, options, and description (`--json` for scripts) |
| `conveyor config get/set <key> [value]` | Reads or changes one setting; validates before saving |
| `conveyor config stage add/remove/move` | Adds (`--after-merge --when …`), removes, or moves a stage |
| `conveyor models [harness]` | Models and efforts each harness offers (cached for a day; `--refresh` asks at once) |
| `conveyor board check`, `conveyor board update` | Compare the board with what this version uses; `update` adds missing labels, the `Conveyor` field, and its missing options, and never changes or deletes anything |
| `conveyor skill install` | Installs the `conveyor-help` skill for Claude Code (`~/.claude/skills`) and harnesses that read `~/.agents/skills`; `--project` installs into the repository |

`--json` prints machine-readable output for `conveyor`, `init`, `new`, `config list`, `config get`, `models`, `board check`, `board update`, `skill install`, and `--version`.

## Control screen

`conveyor` opens the control screen; `conveyor run` in a terminal opens it with the conveyor already running. It uses the whole terminal window and restores it on exit.

The panel `my board: backlog 8|4|6|2 · in progress 1/3 · queued 0 · needs input 0/5 · review 2/2` shows:

- backlog: tasks of the whole board without a form | with `form::idea` | `form::story` | `form::plan`, plus `+N released`: started tasks that nobody owns after `release`. They are listed first, and the conveyor resumes them at their stage before new tasks.
- the other columns: my tasks against my limits. A full limit turns the line yellow; a yellow `no new tasks: … reached · [u] usage` line names a token or subscription limit that stops new tasks.

A task in progress shows whether its stage is alive: `● running here 5m · active 10s ago`, yellow `no activity for 3m`, `runs in conveyor pid N · heartbeat 2m ago`, or `○ not running`.

Keys on the main screen:

- `s`: start the conveyor. While it runs, `s` stops softly: the running stages run to their end, no new stage or task starts (also not from queued), and the conveyor stops when no stage runs; the tasks continue at their next stage on the next start. `s` again during that stops at once.
- `q`: quit. While the conveyor runs, press `q` twice; the conveyor then stops at once.
- `←` `→` select a column, Enter lists its tasks with stage or form, `↓` moves into them.
- `o`: log, the last 30 events; the full log is in `~/.conveyor/logs/<project>.log`.
- `u`: usage: tokens today and the 5h and 7d subscription windows of every harness in use.
- `k`: board check; Enter adds what is missing (labels, the `Conveyor` field, its options).
- `r`: read the board again and run the board check; while the conveyor runs here, start a cycle at once instead of waiting for `poll_interval`.
- `b`: open the board in the browser.
- `n`: new task: `e` in your editor, `i` one-line idea, `h` live harness session.
- `a`: attach to a waiting task; `l`: release a task; `e`: settings editor.
- `h` or `?`: help. On the help screen, `a` opens a live session with the `conveyor-help` skill and installs the skill first when it is missing.

Keys on a task:

- Enter: open its text, workpad, and comments; `p` switches to its pull request; `↑` `↓` scroll.
- `c`: comment; `b`: open it in the browser.
- `h`: live harness session on the task (`live.harness`, `live.model`, `live.effort` from `local.yaml`; instructions in `live/task.md`). When the session ends, it can post a comment on the issue.
- `i`: set or remove `form::idea` (Backlog only).
- `x`: reset one of my tasks; choose the form to start again with: `i` idea, `s` story, `p` plan, `d` draft. Esc cancels.
- Esc: back to the columns.

A stop at once aborts the running stages. They restart from their beginning on the next start; the workspace keeps their files.

## Where things are configured

```
.conveyor/
  config.yaml        team settings, committed
  local.yaml         your personal settings, not committed
  stages/<stage>.md  what each stage does (strict Liquid template, optional `skills:` and `after_merge:` frontmatter); fix-ci.md is a ready repair stage, off until you turn it on
  smart/<gate>.md    when a smart gate asks a human
  live/new.md        instructions for `conveyor new`
  live/attach.md     instructions for `conveyor attach`
  live/task.md       instructions for the live harness session on a task (`h`)
  formats/story.md   the story structure
  triage.md          how triage orders tasks
```

| I want to change … | File | Key |
|---|---|---|
| the board and its GitHub project | `config.yaml` | `board.project`, `board.github_project` |
| the branch that task branches start from and pull requests merge into | `config.yaml` | `board.base_branch` (empty: the default branch of the repository) |
| from which state the conveyor takes tasks | `config.yaml` | `pickup_from` (`idea`, `story`, `plan`) |
| where human decisions happen | `config.yaml` | `transitions` (`interactive`, `autonomous`, `smart`; merge: `human`, `ai`, `smart`) |
| the stages, their order, harness, model, effort | `config.yaml` | `stages`, `defaults`, `triage` |
| what a stage does | `stages/<stage>.md` | text, `skills:` in the frontmatter |
| how a harness is started, its endpoint | `config.yaml`, `local.yaml` | `harnesses` |
| where idea, story, and plan are stored | `config.yaml`, `local.yaml` | `artifacts` (`board`, `repo`, `path`) |
| the documentation language / my chat language | `config.yaml` / `local.yaml` | `language.docs` / `language.chat` |
| the harness and model of my live sessions (`new`, `attach`, `h` on a task, `a` in help) | `local.yaml` | `live.harness`, `live.model`, `live.effort` (empty: `defaults`) |
| approvals needed for merge, merge method, closing done issues | `config.yaml` | `review.approvals`, `merge_method`, `close_on_done` |
| timeouts and retries | `config.yaml` | `timeouts`, `retry` |
| workspace setup scripts | `config.yaml` | `hooks` |
| how much I run in parallel, my token and subscription limits | `local.yaml` | `limits` |
| how often the board is polled, which tasks I take | `local.yaml` | `poll_interval`, `pickup` |

## Harnesses

`claude` and `codex` are built in. `config.yaml` lists the presets for `opencode`, `kilocode`, `pi`, `openhands`, and `agent-zero`. `claude`, `codex`, `opencode`, and `kilocode` are tested with real runs, the last two with a self-hosted model behind LiteLLM; `pi`, `openhands`, and `agent-zero` follow the tools' documentation and are not yet verified. Edit them there or add any other CLI:

```yaml
harnesses:
  opencode:
    command: opencode
    args: [run, --auto, --format, json, -m, "{model}", --variant, "{effort}", --dir, "{workspace}", "{prompt}"]
    env: {}
stages:
  implement: {harness: opencode, model: litellm/<model>}
```

Put personal values, such as your model endpoint or key, in `local.yaml`; `env` merges with the team definition:

```yaml
harnesses:
  openhands:
    env: {LLM_BASE_URL: "http://localhost:4000", LLM_API_KEY: "sk-local"}
```

Placeholders: `{prompt}`, `{model}`, `{effort}`, `{workspace}`, `{result}`, `{artifact}`, `{temp}` (a temporary directory of the run; the `opencode` and `kilocode` presets keep their databases there, so parallel stages do not lock each other). `interactive` sets the args of live sessions. The harness writes its result as JSON to the file in `CONVEYOR_RESULT`; the conveyor adds the schema to the prompt. The harness writes the artifact text (for example the Markdown plan) as plain text to the file in `CONVEYOR_ARTIFACT` and sets only `artifact.kind` in the JSON, so weaker models do not have to escape a long text as a JSON string; `artifact.content` inside the JSON still works when the artifact file is empty.

Codex stages also accept `sandbox: workspace-write | full-access` (default `workspace-write`) and `network: true | false` (default `false`).

Claude stages accept `permission_mode: bypassPermissions | auto | acceptEdits | dontAsk` (default `bypassPermissions`: the harness runs every tool without asking). With another mode, the harness runs only the tools that the mode or the allow rules in the repository's `.claude/settings.json` permit; a denied tool fails that step of the harness, not the stage.

## Talking to the conveyor

The conveyor writes on the board; you answer in comments.

| Where | You write | Effect |
|---|---|---|
| a question or an approval request | any comment | the stage continues with your answer |
| a task in `review`, on the issue or the pull request | `/approve` or an "Approve" review | one approval; with `review.approvals` distinct approvals the conveyor merges (respects blockers, CI, and the merge lock) |
| | `/fix <notes>` or a "Request changes" review | fixes on the same branch, from the `plan` stage |
| | `/fix_from: <stage> <notes>` | fixes on the same branch, from that stage |
| | `/rework <notes>` | new branch, new attempt after `plan` |
| any task | label `conveyor::rework` | same as `/rework` |

An approval or `/approve` counts only for the head commit under review. When someone else pushes to the task branch, the conveyor comments that the branch changed and waits for a new approval.

The conveyor reads commands, reviews, replies, and its own hidden markers only from users with write access to the repository (GitHub: write, maintain, or admin; GitLab: Developer or higher). It takes only tasks whose author has write access; to run a task from an outside contributor, create a new issue with its content.

On GitLab, `/approve` in a merge request comment is GitLab's own approval, and the conveyor counts it. Do not write `/merge` there: it is a GitLab quick action that merges the request at once, past the conveyor's checks. `/fix`, `/fix_from:`, and `/rework` work on both.

### Board

Three kinds of labels describe a task. `conveyor init` creates all of them. On every start and on the control screen the conveyor compares the board with what its version uses and only reports the difference: missing labels, a missing `Conveyor` field or options, labels it no longer uses, and open tasks that carry them. `conveyor board check` prints the same report. `conveyor board update`, or `k` and Enter on the control screen, adds what is missing (labels, the `Conveyor` field, and its missing options) with your consent; the conveyor never changes or deletes existing labels, fields, options, card values, or task labels. Closed tasks are not checked.

| Labels | Meaning | Set by |
|---|---|---|
| `conveyor::backlog` | the column of tasks that wait for the conveyor or for humans | humans |
| `form::idea`, `form::story`, `form::plan` | the task is ready for the conveyor in this form; without a form it is a draft for humans | humans; the conveyor removes the form when it takes the task |
| `conveyor::needs-input`, `queued`, `in-progress`, `review`, `done` | the column of a task the conveyor works on | the conveyor |
| `stage::<name>` | the stage that runs or waits for input, one label for every stage in `config.yaml` | the conveyor; removed at review and done |
| `conveyor::rework` | a signal: start the task over after `plan`, like `/rework` | humans |

The board has one column per state: **Backlog → Needs input → Queued → In progress → Review → Done**, then Closed. Every stage, from `story` to `merge` and custom stages such as `polish`, runs in In progress; its `stage::` label shows which one. A card in In progress with `stage::plan` is a plan being written; a card in Needs input with `stage::plan` is a plan that waits for an answer.

The conveyor takes an open task that has a `form::` label allowed by `pickup_from` and no `conveyor::` state other than `backlog`. `form::idea` starts with the `story` stage, `form::story` with `plan`, `form::plan` with the first stage after `plan`.

Set up the board once:

- **GitHub:** the board with columns is a GitHub project; labels alone give no board there. `conveyor init` (or later `conveyor board update`, or `k` and Enter) uses the project linked to the repository or creates and links one, adds the `Conveyor` field, and writes `board.github_project`. GitHub does not move cards by labels itself; the conveyor does it: every cycle of `conveyor run`, `conveyor board update`, and `k` add open issues with a `conveyor::` label to the project and set their `Conveyor` value from the label. Once, in the project, choose the Board layout and "Column by: Conveyor" (GitHub has no API for views). Without `board.github_project` the start log, the control screen, and `conveyor board check` report that the board has no columns.
- **GitLab:** open Issues → Boards and add one list per label in this order: `conveyor::backlog`, `needs-input`, `queued`, `in-progress`, `review`, `done`.

A large story can merge in **parts**: the `plan` stage returns their order in `parts`, and each part becomes one pull request. The conveyor runs the stages after `plan` for part 1, reviews and merges it, then moves the task back to In progress for part 2 on a fresh branch from the updated base branch, and so on. The card shows `part::2/3`, the pull request title names the part, and the story is done after the last part merges.

Merge is safe for parallel tasks: the conveyor merges a pull request only when its checks are green (it waits up to 5 minutes for CI to start), and only when the task branch contains the latest base branch. A branch that fell behind is rebased and tested again; a rebase conflict (for example two tasks add the same migration number) sends the task back to the `merge` stage. A human pull request already linked to the issue makes the conveyor ask first (`/continue` its branch or `/fresh`), and a draft pull request is never merged. When the base branch is already red, the conveyor opens one task that fixes it, takes it first, and holds every other merge until the base is green, so the failure does not spread into later tasks. After the merge the conveyor waits for the CI of the merge commit; when it fails, a `when: failure` stage such as `fix-ci` repairs the base branch through a follow-up pull request, or the task asks a human. In needs-input after failed checks or a failed merge, a plain reply retries the merge, and `/fix`, `/fix_from: <stage>`, or `/rework` with your notes send the task back to work. In needs-input after the base CI failed after the merge, `/fix_from: implement <notes>` fixes it in a follow-up pull request, and any other reply finishes the task. Pull requests and claimed issues are assigned to the conveyor user; a pull request says `Closes #N` when the conveyor closes the issue anyway, otherwise `Part of #N`; the workpad links the task branch and the pull request.

A harness at its subscription limit pauses its stages until the reset time named in its error; this counts as no failed attempt.

A finished task gets `conveyor::done` and stays open (`close_on_done: false`, the default), so a human closes it, for example after a sprint review. With `close_on_done: true` the conveyor closes the issue itself; on GitLab it then moves to the built-in Closed list.

On GitLab Free, issue links are not available; the conveyor keeps blockers in a `Blocked by: #N` line in the issue description.

## Security

The conveyor runs harnesses with your permissions and merges with your token. Before you use it on a real repository:

- Protect the base branch (`board.base_branch`, else the default branch): require pull requests and status checks, and dismiss stale approvals. The conveyor pushes only to its own branches `conveyor/<issue>` and merges through pull requests, so a base branch that accepts changes only through pull requests works. When the protection requires approvals that your token cannot bypass, use `transitions.merge: human`: with `ai` the merge fails and the task goes to Needs input.
- Limit the harnesses with `permission_mode` (claude stages) and `sandbox`/`network` (codex stages), or run the conveyor in a container or under a separate user with a token for that board only.
- Review changes to `.conveyor/` like code: `hooks` and harness commands run on every workstation.

For a repository you care about, run the conveyor as a separate bot account with access to that repository only; the steps are in "Recommended setup" in SECURITY.md. The full trust model and how to report a vulnerability are in [SECURITY.md](https://github.com/phalbohr/conveyor/blob/main/SECURITY.md).

## Development

```bash
npm install
npm test
npm run build
```

Contract tests against real services run on demand:

```bash
CONVEYOR_GITHUB_SANDBOX=owner/sandbox-repo npx vitest run test/board.test.ts
```

```bash
CONVEYOR_HARNESS_REAL=claude:haiku,codex:gpt-6-luna npx vitest run test/harness.test.ts
```

```bash
CONVEYOR_GITLAB_SANDBOX=group/sandbox-project npx vitest run test/board.test.ts
```

Do not run the board contract tests while a conveyor works on the same sandbox board: it may claim the test tasks.

Contributions: see [CONTRIBUTING.md](https://github.com/phalbohr/conveyor/blob/main/CONTRIBUTING.md).

## License

MIT
