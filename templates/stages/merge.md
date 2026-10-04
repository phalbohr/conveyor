# Stage: merge

Prepare the change for merge.

- Fetch the latest base branch and rebase the task branch on it. Resolve conflicts.
- Run the full test suite and fix failures.
- Do not push and do not open a pull request. The conveyor pushes the branch, opens the pull request, and merges according to the merge mode.

This stage needs write access to git. With codex, use `sandbox: full-access` for this stage.
