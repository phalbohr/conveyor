---
after_merge: failure
---
# Stage: fix-ci

Repair what made the merge fail. The section "Merge" above says what happened: checks of the pull request failed, the branch conflicts with the base branch, or the CI of the base branch failed after this task was merged (then this workspace starts from the latest base branch, and your fix goes into a follow-up pull request).

- Find the failing checks and reproduce the failure locally: run the failing tests or the project's CI script.
- Fix the cause with the smallest change that makes every check pass.
- If the latest base branch already fixes the same failure in another way, keep the base version and drop this branch's own fix for it.
- Keep the tests honest: do not skip, disable, or delete a test to make it pass, and do not weaken an assertion.
- Do not edit a database migration that is already merged; add a new migration with the next free version instead.
- Resolve conflicts by intent: the base side is work of other tasks that is already merged, this side is this task. Keep the result that fulfils both intents; often that combines both changes (for example renumber this task's migration after one that is already merged). When one side replaces the other on purpose, keep that side. When the intents contradict and the story and the plan do not decide it, do not guess: return outcome `questions` that describes the conflict and the options.
- While you fix, rerun only the failing tests (one test case or one test file); run the full test suite once, at the end of the stage.
- Save the output of a long test run or build to a file and read it from there; do not run the same command again only to filter its output differently.
- Change text and code where it is, one place at a time, in its context. Do not run search-and-replace over many files (sed, perl, scripts) for ordinary words or texts. For a rename across files, use the tools of the language or replace only the exact identifier, and check every hit.
- Run checks in the foreground and wait for them; you cannot schedule a later wakeup.
- In the summary, name the cause and the fix.
