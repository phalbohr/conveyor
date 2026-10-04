# Smart gate: merge

Send the change to human review when at least one condition is true:

- The change touches security-sensitive code, a data schema, or a public interface.
- The change adds or upgrades a dependency.
- The diff has more than 400 changed lines.
- A test was skipped, removed, or is flaky.

Otherwise the conveyor merges the change.
