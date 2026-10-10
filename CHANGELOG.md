# Changelog

## 0.1.0 — 2026-10-08

First public release.

- Board adapters for GitHub (`gh`) and GitLab (`glab`), with GitHub Projects mirroring and the GitLab Free fallback for blockers.
- Configurable stages from idea to merge and after merge, with interactive, autonomous, and smart gates.
- Harnesses: `claude` and `codex` built in; presets for `opencode` and `kilocode` (verified with real runs), `pi`, `openhands`, and `agent-zero` (not yet verified with real runs); any CLI through `harnesses`.
- Several workstations on one board: atomic claims, heartbeats, merge and triage locks, personal limits, and subscription reserves.
- Board labels: `conveyor::` states as columns (backlog, needs-input, queued, in-progress, review, done), `form::idea|story|plan` marks a task ready for the conveyor, `stage::<name>` shows the running stage.
- Review command `/approve` (one approval; the conveyor merges after `review.approvals` distinct approvals). On GitLab, `/approve` in a merge request is GitLab's own approval and counts.
- `close_on_done` (default `false`): finished issues stay open with `conveyor::done` until a human closes them.
- The init menu has Cancel and Esc; the help screen starts a live session with the conveyor-help skill on `a`.
- GitHub boards: `init` and `conveyor board update` use the project linked to the repository or create and link one; the board check reports a missing project.
- Board upgrades: every start and the control screen report what the board lacks for this version; `conveyor board update` (or `k`) adds it on request and never changes or deletes existing labels or fields.
- Parts: the plan can split a story into ordered parts, one pull request each; the story is done after the last part merges.
- Board panel on the control screen: Backlog by form and my columns against my limits; open a task with its text, workpad, comments, and pull request; comment, open in the browser, open it in a live session with the harness, and toggle `form::idea`.
- Control screen with a live log, settings editor, `new`, `attach`, `release`, `config`, `models`, and the `conveyor-help` skill.
- Trust checks: tasks, comments, reviews, and commands only from users with write access; secret redaction on the board, in committed artifacts, and in the log; approvals and merges bound to the reviewed head commit.
