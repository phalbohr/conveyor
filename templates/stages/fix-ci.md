---
after_merge: failure
---
# Stage: fix-ci

Repair what made the merge fail. The section "Merge" above says what happened: checks of the pull request failed, the branch conflicts with the base branch, or the CI of the base branch failed after this task was merged (then this workspace starts from the latest base branch, and your fix goes into a follow-up pull request).

- Find the failing checks and reproduce the failure locally: run the failing tests or the project's CI script.
- Fix the cause with the smallest change that makes every check pass.
- Keep the tests honest: do not skip, disable, or delete a test to make it pass, and do not weaken an assertion.
- Do not edit a database migration that is already merged; add a new migration with the next free version instead.
- Resolve conflicts so that the changes of both sides stay.
- Run the full test suite before you finish.
- In the summary, name the cause and the fix.
