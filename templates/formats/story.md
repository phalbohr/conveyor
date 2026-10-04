**Actors:** <who takes part: user roles, external systems>

**Story:** As a <role>, I want <action>, so that <benefit>.

**Current problem:** <what prevents the role from doing the action today; a short vertical slice>

**Main scenario:**

1. <Actor> does X.
2. The system validates Y.
3. The system does Z.
4. The system shows the result.

**Alternative scenarios:**

- **ALT1:** <condition> → at step <n>:
  1. The system detects the problem.
  2. The system shows a message.

**Acceptance criteria:**

- [ ] **AC1: <name>**
  **Given** <context>
  **When** <action>
  **Then** <outcome>

**Dependencies:** <tasks that must be done first, or "none">

Rules:

- Describe every step concretely. "The system processes data" is too vague; "The system validates the email format and checks for duplicates" is concrete.
- Describe what the system does, not how it is implemented. Do not write code.
- Include alternative scenarios for errors and edge cases.
- Use measurable criteria instead of words like "fast" or "user-friendly".
- More than 5–6 acceptance criteria means the story is too big: propose to split it.
- Keep the story short as long as it stays clear.
