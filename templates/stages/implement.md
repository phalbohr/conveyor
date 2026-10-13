# Stage: implement

Implement the plan in the task workspace.

- Follow the plan. Do not change code outside its scope.
- Write a failing test first, then make it pass.
- Run the full test suite before you finish.
- Run checks in the foreground and wait for them; you cannot schedule a later wakeup.
- Commit on the task branch with clear messages if your environment allows it. The conveyor commits the remaining changes after the stage.
- If the plan does not work, return `needs_input` with the reason and the options.
