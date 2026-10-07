# Security

## Report a vulnerability

Report vulnerabilities privately through [GitHub security advisories](https://github.com/phalbohr/conveyor/security/advisories/new). Do not open a public issue. You get an answer within 7 days.

## Supported versions

Only the latest release gets security fixes.

## Trust model

The conveyor runs coding agents on your machine, as your user. Know these limits before you run it:

- **Agents have your permissions.** Claude stages run with `permission_mode: bypassPermissions` by default: the agent can read and change anything your user can, including git, `gh`, and `glab` credentials. The conveyor removes board tokens from the agent environment, but the agent can still reach credentials in the keyring or in files. Limit the agent with `permission_mode` and the allow rules in the repository's `.claude/settings.json`, or run the conveyor in a container or under a separate user with a token for that board only.
- **Task text is a prompt.** Everything in a task, its comments, and the repository goes into the agent's prompt. The conveyor takes only tasks whose author has write access to the repository, and it reads comments, reviews, commands, workpads, and artifacts only from users with write access. Users with write access can still steer the agent.
- **The team configuration runs commands.** `hooks` and `harnesses.*.command` in `.conveyor/config.yaml` run on every workstation at the next cycle after a change is pulled. Review changes to `.conveyor/` like code.
- **The conveyor does not replace branch protection.** It merges with your token. Protect the default branch: require pull requests and status checks, and dismiss stale approvals.
- **Board output is public in public repositories.** The conveyor hides token patterns and the values of secret environment variables (`*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`) in everything it writes to the board, but it cannot recognize every secret. Keep secrets out of the repository and the agent's reach.
