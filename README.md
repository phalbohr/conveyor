# conveyor

A configurable development conveyor. Tasks live on a GitHub or GitLab board. Agents from different harnesses move each task through stages — story, plan, implement, review, merge — and a human decides at the gates you choose. Several workstations can work on one board at the same time.

The design is in [docs/design.md](docs/design.md).

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
| `conveyor` | Shows the settings and validates them; without settings, starts the init menu |
| `conveyor init` | Creates settings or links existing ones |
| `conveyor run` | Works the board: claims tasks within your limits and runs their stages. `--once` runs one cycle |
| `conveyor new` | Live session with an agent; creates a task from the result |
| `conveyor attach <issue>` | Live session to answer the questions of a waiting task |
| `conveyor release <issue>` | Releases the claim of a task (`--force` for private tasks of others) |

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

Codex stages also accept `sandbox: workspace-write | full-access` and `network: true | false`.

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
