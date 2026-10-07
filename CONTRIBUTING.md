# Contributing

## Set up

```bash
npm install
npm run typecheck
npm test
npm run build
npm link
```

Node.js 22.12 or later, git, macOS or Linux.

## Change the code

- Branch from `develop` and open the pull request against `develop`.
- Every change comes with a test; `npm test` must pass.
- Match the style of the surrounding code. The code has no comments; names and tests carry the meaning.
- Update `README.md`, `skills/conveyor-help/workflow.md`, and `docs/design.md` when behaviour changes.

## Contract tests

Tests against real boards and harnesses run only on demand. See "Development" in the README.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
