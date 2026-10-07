# Changelog

## 0.1.0 — unreleased

First public release.

- Board adapters for GitHub (`gh`) and GitLab (`glab`), with GitHub Projects mirroring and the GitLab Free fallback for blockers.
- Configurable stages from idea to merge and after merge, with interactive, autonomous, and smart gates.
- Harnesses: `claude` and `codex` built in; presets for `opencode` and `kilocode` (verified with a self-hosted model behind LiteLLM), `pi`, `openhands`, and `agent-zero` (not yet verified with real runs); any CLI through `harnesses`.
- Several workstations on one board: atomic claims, heartbeats, merge and triage locks, personal limits, and subscription reserves.
- Control screen with a live log, settings editor, `new`, `attach`, `release`, `config`, `models`, and the `conveyor-help` skill.
- Trust checks: tasks, comments, reviews, and commands only from users with write access; secret redaction on the board, in committed artifacts, and in the log; approvals and merges bound to the reviewed head commit.
