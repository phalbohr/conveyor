# Stage: merge

Prepare the change for merge.

- Fetch the latest base branch and rebase the task branch on it.
- Resolve conflicts by intent: the base side is work of other tasks that is already merged, this side is this task. Keep the result that fulfils both intents; often that combines both changes (for example renumber this task's migration after one that is already merged). When one side replaces the other on purpose, keep that side. When the intents contradict and the story and the plan do not decide it, do not guess: return outcome `questions` that describes the conflict and the options.
- Run the full test suite and fix failures.
- Do not push and do not open a pull request. The conveyor pushes the branch, opens the pull request, and merges according to the merge mode.

This stage needs write access to git. With codex, use `sandbox: full-access` for this stage.
