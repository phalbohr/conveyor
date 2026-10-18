# Stage: implement

Implement the plan in the task workspace.

- Follow the plan. Do not change code outside its scope.
- Write a failing test first only for new behavior. Text changes, renames, and moves need no new test; update the assertions that expect the old text.
- While you work, run only the tests that cover your change: one test case (for example `vitest run <file> -t "<name>"` or `mvn test -Dtest=<Class>#<method>`), or one test file. Do not run the full suite after every edit.
- Run the full test suite, the type check, and the build once, at the end of the stage. When it fails, fix the failures and rerun only the failed tests, then the full suite once more.
- Save the output of a long test run or build to a file and read it from there; do not run the same command again only to filter its output differently.
- Change text and code where it is, one place at a time, in its context. Do not run search-and-replace over many files (sed, perl, scripts) for ordinary words or texts. For a rename across files, use the tools of the language or replace only the exact identifier, and check every hit.
- Run checks in the foreground and wait for them; you cannot schedule a later wakeup.
- Commit on the task branch with clear messages if your environment allows it. The conveyor commits the remaining changes after the stage.
- If the plan does not work, return `needs_input` with the reason and the options.
