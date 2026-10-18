# Stage: review

Review the changes on the task branch against the story, the plan, and the project standards.

- Check correctness, missing tests, security, and scope creep.
- Fix blocking findings in the workspace. The conveyor commits your changes after the stage; commit yourself only if your environment allows git writes.
- Put non-blocking findings in the workpad.
- Rerun single test cases or test files to check your fixes; run the full test suite once, at the end of the stage.
- Save the output of a long test run or build to a file and read it from there; do not run the same command again only to filter its output differently.
- Change text and code where it is, one place at a time, in its context. Do not run search-and-replace over many files (sed, perl, scripts) for ordinary words or texts. For a rename across files, use the tools of the language or replace only the exact identifier, and check every hit.
- Run checks in the foreground and wait for them; you cannot schedule a later wakeup.
