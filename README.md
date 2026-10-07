# conveyor

A configurable development conveyor. Tasks live on a GitHub or GitLab board. Agents from different harnesses move each task through stages — story, plan, implement, review, merge — and a human decides at the gates you choose. Several workstations can work on one board at the same time.

The full workflow, from an idea to a merged change, is in [skills/conveyor-help/workflow.md](https://github.com/phalbohr/conveyor/blob/main/skills/conveyor-help/workflow.md). The design is in [docs/design.md](https://github.com/phalbohr/conveyor/blob/main/docs/design.md).

After `conveyor skill install`, ask your agent anything about the conveyor: it explains the workflow and settings and changes them for you.

## Status

Alpha (0.x). The configuration format and the board labels can change between minor versions; [CHANGELOG.md](https://github.com/phalbohr/conveyor/blob/main/CHANGELOG.md) lists every change. The `claude` and `codex` harnesses and the GitHub and GitLab boards are tested with real runs; the other harness presets are not yet.

Agents run as your user and, by default, without permission prompts. Read [Security](#security) before the first run.

## Requirements

- macOS or Linux. Windows is not supported.
- Node.js 22.12 or later, and git.
- GitHub: `gh`, signed in (`gh auth login`), with the `project` scope if you mirror states to GitHub Projects.
- GitLab: `glab`, signed in (`glab auth login`).
- The CLI of every harness your settings use, signed in. The default settings use `claude` (Claude Code) for every stage and for triage; `codex`, `opencode`, `pi`, `openhands`, and `a0` are needed only when a stage uses them.

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

### First run, step by step

1. In a repository whose `origin` is on GitHub or GitLab, run `conveyor init` and commit `.conveyor/`.
2. Create an issue yourself (the conveyor takes only tasks from users with write access) and add the label `conveyor::plan`. Write the plan in the issue text.
3. Run `conveyor`: the control screen opens. Press `c` to start the conveyor.
4. The log shows `claimed task <number>` and each stage. The issue gets `conveyor::in-progress`, then a pull request opens and the issue gets `conveyor::review`.
5. Review the pull request. Write `/merge` (or approve) to merge, `/fix <notes>` to fix on the same branch, or `/rework <notes>` to start over.

The task is not taken? Check that the label matches `pickup_from` and the issue has no open blockers. The control screen shows your limits and the team queue with the owner of each task; its log shows tasks skipped because their author has no write access. Every stage call costs tokens of the harness account; set `limits.daily_tokens` and the subscription reserves in `conveyor settings`. Stop with `c` or `q`; running stages abort, and the next start resumes the tasks.

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

`--json` prints machine-readable output for `conveyor`, `init`, `new`, `config list`, `config get`, `models`, `skill install`, and `--version`.

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

`claude` and `codex` are built in and tested with real runs. `config.yaml` lists the presets for `opencode`, `pi`, `openhands`, and `agent-zero`; they follow the tools' documentation and are not yet verified with real runs. Edit them there or add any other CLI:

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

An approval or `/merge` counts only for the head commit under review. When someone else pushes to the task branch, the conveyor comments that the branch changed and waits for a new approval.

The conveyor reads commands, reviews, replies, and its own hidden markers only from users with write access to the repository (GitHub: write, maintain, or admin; GitLab: Developer or higher). It takes only tasks whose author has write access; to run a task from an outside contributor, create a new issue with its content.

On GitLab, `/merge` in a merge request comment is a GitLab quick action and never reaches the conveyor. Approve the merge request (button or `/approve`) or write `/merge` on the issue. `/fix`, `/fix_from:`, and `/rework` work on both.

GitLab boards use labels as lists: create an issue board with lists for the `conveyor::*` labels. On GitLab Free, issue links are not available; the conveyor keeps blockers in a `Blocked by: #N` line in the issue description.

## Security

The conveyor runs agents with your permissions and merges with your token. Before you use it on a real repository:

- Protect the default branch: require pull requests and status checks, and dismiss stale approvals.
- Limit the agents with `permission_mode` (claude stages) and `sandbox`/`network` (codex stages), or run the conveyor in a container or under a separate user with a token for that board only.
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
