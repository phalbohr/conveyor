# conveyor

A configurable development conveyor. Tasks live on a GitHub or GitLab board. Agents from different harnesses move each task through stages — story, plan, implement, review, merge — and a human decides at the gates you choose. Several workstations can work on one board at the same time.

The full workflow, from an idea to a merged change, is in [skills/conveyor-help/workflow.md](skills/conveyor-help/workflow.md). The design is in [docs/design.md](docs/design.md).

After `conveyor skill install`, ask your agent anything about the conveyor: it explains the workflow and settings and changes them for you.

## Requirements

- Node.js 20 or later.
- GitHub: `gh`, signed in (`gh auth login`), with the `project` scope if you mirror states to GitHub Projects.
- GitLab: `glab`, signed in (`glab auth login`).
- The CLI of every harness your stages use: `claude`, `codex`, `opencode`, `pi`, `openhands`, or `a0`.

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

`conveyor init` reads the board from `git remote origin` and creates `.conveyor/`. Without a terminal, pass `--provider github --project owner/repo`. To keep the settings outside the repository, use `--path <dir>`; to reuse existing settings, use `--use <dir>`.

Put a task on the board with the label `conveyor::plan` (or `conveyor::story` / `conveyor::idea`, depending on `pickup_from`), or shape one with an agent:

```bash
conveyor new
```

## Commands

| Command | What it does |
|---|---|
| `conveyor` | Control screen: `c` starts or stops the conveyor in this window with a live log below the status, `n` new task, `a` attach, `l` release, `s` settings. Status: whether `run` works, my tasks with stage, retries, errors, and pending answers, my limits, token use, subscription windows, the team queue. Keys: `c` start/stop, `n` new, `a` attach, `l` release, `s` settings, `r` refresh, `h` help, `q` quit. Without a terminal it prints a text summary; `--json` prints the snapshot. Without settings it starts the init menu |
| `conveyor init` | Creates settings or links existing ones |
| `conveyor settings` | Settings editor (also `s` on the status screen): team, stage, and personal fields; `←` `→` switch between the options of a field, `a` add a stage, `x` remove, `[` `]` move, `s` save after validation, `q` quit. Formatting and comments of the YAML files stay as they are |
| `conveyor run` | Works the board: claims tasks within your limits and runs their stages. In a terminal it opens the control screen with the conveyor already running; without a terminal (server, cron) it prints the log. `--once` runs one cycle. The log also goes to `~/.conveyor/logs/<project>.log` |
| `conveyor new` | Live session with an agent; creates a task from the result |
| `conveyor attach <number>` | Live session to answer the questions of a waiting task; `<number>` is the issue number on the board, e.g. `51` |
| `conveyor release <number>` | Releases the claim of a task (`--force` for private tasks of others) |
| `conveyor config list` | Every setting with value, options, and description (`--json` for scripts) |
| `conveyor config get/set <key> [value]` | Reads or changes one setting; validates before saving |
| `conveyor config stage add/remove/move` | Adds (`--after-merge --when …`), removes, or moves a stage |
| `conveyor models [harness]` | Models and efforts each harness offers (cached; `--refresh` asks again) |
| `conveyor skill install` | Installs the `conveyor-help` skill for Claude Code (`~/.claude/skills`) and agents that read `~/.agents/skills`; `--project` installs into the repository |

Every command accepts `--json`.

## Where things are configured

```
.conveyor/
  config.yaml        team settings, committed
  local.yaml         your personal settings, not committed
  stages/<stage>.md  what each stage does (strict Liquid template, optional `skills:` frontmatter)
  smart/<gate>.md    when a smart gate asks a human
  live/new.md        instructions for `conveyor new`
  live/attach.md     instructions for `conveyor attach`
  formats/story.md   the story structure
  triage.md          how triage orders tasks
```

| I want to change … | File | Key |
|---|---|---|
| the board, the GitHub Projects mirror | `config.yaml` | `board.project`, `board.github_project` |
| from which state the conveyor takes tasks | `config.yaml` | `pickup_from` (`idea`, `story`, `plan`) |
| where human decisions happen | `config.yaml` | `transitions` (`interactive`, `autonomous`, `smart`; merge: `human`, `ai`, `smart`) |
| the stages, their order, harness, model, effort | `config.yaml` | `stages`, `defaults`, `triage` |
| what a stage does | `stages/<stage>.md` | text, `skills:` in the frontmatter |
| how a harness is started, its endpoint | `config.yaml`, `local.yaml` | `harnesses` |
| where idea, story, and plan are stored | `config.yaml`, `local.yaml` | `artifacts` (`board`, `repo`, `path`) |
| the documentation language / my chat language | `config.yaml` / `local.yaml` | `language.docs` / `language.chat` |
| approvals needed for merge, merge method | `config.yaml` | `review.approvals`, `merge_method` |
| timeouts and retries | `config.yaml` | `timeouts`, `retry` |
| workspace setup scripts | `config.yaml` | `hooks` |
| how much I run in parallel, my token and subscription limits | `local.yaml` | `limits` |
| how often the board is polled, which tasks I take | `local.yaml` | `poll_interval`, `pickup` |

## Harnesses

`claude` and `codex` are built in. `config.yaml` lists the presets for `opencode`, `pi`, `openhands`, and `agent-zero`; edit them there or add any other CLI:

```yaml
harnesses:
  opencode:
    command: opencode
    args: [run, --auto, -m, "{model}", --dir, "{workspace}", "{prompt}"]
    env: {}
stages:
  implement: {harness: opencode, model: litellm/qwen3-coder}
```

Put personal values, such as your model endpoint or key, in `local.yaml`; `env` merges with the team definition:

```yaml
harnesses:
  openhands:
    env: {LLM_BASE_URL: "http://localhost:4000", LLM_API_KEY: "sk-local"}
```

Placeholders: `{prompt}`, `{model}`, `{effort}`, `{workspace}`, `{result}`. The agent writes its result as JSON to the file in `CONVEYOR_RESULT`; the conveyor adds the schema to the prompt.

Codex stages also accept `sandbox: workspace-write | full-access` (default `workspace-write`) and `network: true | false` (default `false`).

Claude stages accept `permission_mode: bypassPermissions | auto | acceptEdits | dontAsk` (default `bypassPermissions`: the agent runs every tool without asking). With another mode, the agent runs only the tools that the mode or the allow rules in the repository's `.claude/settings.json` permit; a denied tool fails that step of the agent, not the stage.

## Talking to the conveyor

The conveyor writes on the board; you answer in comments.

| Where | You write | Effect |
|---|---|---|
| a question or an approval request | any comment | the stage continues with your answer |
| a task in `review`, on the issue or the pull request | `/merge` or an "Approve" review | merge (respects blockers, CI, and the merge lock) |
| | `/fix <notes>` or a "Request changes" review | fixes on the same branch, from the `plan` stage |
| | `/fix_from: <stage> <notes>` | fixes on the same branch, from that stage |
| | `/rework <notes>` | new branch, new attempt after `plan` |
| any task | label `conveyor::rework` | same as `/rework` |

The conveyor reads commands, reviews, replies, and its own hidden markers only from users with write access to the repository (GitHub: write, maintain, or admin; GitLab: Developer or higher). It takes only tasks whose author has write access; to run a task from an outside contributor, create a new issue with its content.

On GitLab, `/merge` in a merge request comment is a GitLab quick action and never reaches the conveyor. Approve the merge request (button or `/approve`) or write `/merge` on the issue. `/fix`, `/fix_from:`, and `/rework` work on both.

GitLab boards use labels as lists: create an issue board with lists for the `conveyor::*` labels. On GitLab Free, issue links are not available; the conveyor keeps blockers in a `Blocked by: #N` line in the issue description.

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

## License

MIT
