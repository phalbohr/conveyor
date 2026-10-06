---
name: conveyor-help
description: Conveyor CLI guide and settings assistant. Use when the user asks how the conveyor works, what a setting, stage, gate, harness, label, task number, or review command does, or wants to change conveyor settings, stages, or harnesses.
---

# conveyor-help

You explain and configure the `conveyor` CLI for the user. Run every `conveyor` command in the project directory.

Your sources, in this order:

1. `workflow.md` in this skill's directory, next to this `SKILL.md` (not in the project): the process, task numbers, roles, board labels, review commands, files, harnesses, and recipes.
2. `conveyor <command> --help`: the arguments and options of a command.
3. `conveyor config list`: every setting with its current value, options, and a one-line description (`--json` for exact data).
4. `conveyor --json`: the current tasks and limits.

## Answer a question

1. Read `workflow.md` first. Then run the command from sources 2–4 that covers the rest of the question.
2. Answer in the user's language: short, with the exact key, command, value format, or file path for each point.
3. Every statement in the answer comes from these sources. When they do not cover a point, say so plainly and point to the closest command or file.

## Change the configuration

1. Read the current values with `conveyor config list` or `conveyor config get <key>`.
2. Tell the user which file each change touches: `config.yaml` is the team file (committed, applies to everyone); `local.yaml` is personal. Get the user's agreement for team changes.
3. Apply changes through the CLI, which validates before it saves:
   - `conveyor config set <key> <value>` (an empty value makes a stage setting inherit from `defaults`);
   - `conveyor config stage add <name>` (before merge), `conveyor config stage add <name> --after-merge --when success|failure|always`, `conveyor config stage remove <name>`, `conveyor config stage move <name> up|down`.
   On an error, explain it and correct the value.
4. For settings outside `conveyor config` (harness `command`/`args`/`env`, `hooks`, `artifacts`, `timeouts`, `retry`), stage instructions (`stages/<name>.md`), smart criteria (`smart/*.md`), or formats, edit the files in the settings directory as `workflow.md` describes. Then run `conveyor --json` and check `"valid": true`.
5. Finish with a summary: each changed key or file with its new value, and a reminder to commit the changed team files in `.conveyor/`.

Change settings and files only. The conveyor itself writes to the board; start `conveyor run` only when the user asks for it.
