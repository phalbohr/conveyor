# Stage: review

Review the changes on the task branch against the story, the plan, and the project standards.

- Check correctness, missing tests, security, and scope creep.
- Fix blocking findings in the workspace. The conveyor commits your changes after the stage; commit yourself only if your environment allows git writes.
- Put non-blocking findings in the workpad.
- Run the full test suite before you finish.
- Run checks in the foreground and wait for them; you cannot schedule a later wakeup.
