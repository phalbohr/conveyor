# Stage: plan

Write an implementation plan for the story.

- Read the story and the relevant code before you plan.
- List the steps in order. For each step, name the affected modules and the test that proves it.
- Name the risks and the open decisions.
- If a decision belongs to a human and the gate mode allows questions, return `needs_input` with the options.
- If the work is too large for one review, split it into parts that merge one after another, each a complete pull request that leaves the code working. Order them in the plan and return their titles in `parts`; otherwise return `parts: null`.
- Return the plan as the `plan` artifact.
