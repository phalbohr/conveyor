---
name: conveyor-help
description: Conveyor CLI guide and settings assistant. Use when the user asks how the conveyor works, what a setting, stage, gate, harness, label, task number, review command, or failure means, wants to change conveyor settings, stages, or harnesses, or wants a guided setup of the conveyor.
---

# conveyor-help

You explain and configure the `conveyor` CLI for the user. Run every `conveyor` command in the project directory.

Your sources, in this order:

1. The files in this skill's directory, next to this `SKILL.md` (not in the project):
   - `workflow.md`: the process, task numbers, roles, board labels, review commands, failures, files, harnesses, and recipes;
   - `setup.md`: the guided setup, and the exact meaning of every setting and how settings depend on each other.
2. `conveyor <command> --help`: the arguments and options of a command.
3. `conveyor config list`: every setting with its current value, options, and a one-line description (`--json` for exact data).
4. `conveyor --json`: the current tasks and limits.
5. The conveyor log `~/.conveyor/logs/<owner-repo>.log` (the board project with `/` replaced by `-`): what the conveyor did and why tasks wait, newest lines last.

## Guided setup

When the user wants to go through the settings or set up the conveyor, follow `setup.md` step by step.

## Answer a question

1. Read `workflow.md` first; for the meaning of a setting, read its step in `setup.md`. Then run the command from sources 2–5 that covers the rest of the question.
2. Answer in the user's language: short, with the exact key, command, value format, or file path for each point.
3. Every statement in the answer comes from these sources. When they do not cover a point, say so plainly and point to the closest command or file.

## Explain the state of the board

When the user asks why tasks wait, what blocks them, or what to do with a stuck task:

1. Run `conveyor --json` and read the last 200 lines of the log; match each task in question to its state, stage, and its latest log lines.
2. Name the cause per task with the log line or the snapshot field that shows it (for example a CI freeze by a fix task, a full `running` limit, `blockedBy` of a backlog task, a missing answer, a red base, checks that wait). For a task that is not taken, check the rules of "Which tasks the conveyor takes" in `workflow.md` one by one.
3. Give the next step from `workflow.md` (answer in the issue, `/approve`, `x` to reset, `conveyor release`, a setting to change). Change nothing on the board or in the settings without the user's go-ahead.

## Change the configuration

1. Read the current values with `conveyor config list` or `conveyor config get <key>`.
2. Tell the user which file each change touches: `config.yaml` is the team file (committed, applies to everyone); `local.yaml` is personal. Get the user's agreement for team changes.
3. Apply changes through the CLI, which validates before it saves:
   - `conveyor config set <key> <value>` (an empty value makes a stage setting inherit from `defaults`), also for codex `stages.<name>.sandbox` and `stages.<name>.network`;
   - `conveyor config stage add <name>` (before merge), `conveyor config stage add <name> --after-merge --when success|failure|always`, `conveyor config stage remove <name>`, `conveyor config stage move <name> up|down`.
   On an error, explain it and correct the value.
4. For settings outside `conveyor config` (harness `command`/`args`/`env`, `hooks`, `artifacts`, `checks.ignore`, `repos`, `repo_paths`), stage instructions (`stages/<name>.md`), smart criteria (`smart/*.md`), or formats, edit the files in the settings directory as `workflow.md` describes. Then run `conveyor --json` and check `"valid": true`.
5. Finish with a summary: each changed key or file with its new value, and a reminder to commit the changed team files in `.conveyor/`.

Change settings and files only. The conveyor itself writes to the board; start `conveyor run` only when the user asks for it.
