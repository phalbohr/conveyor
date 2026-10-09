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
- **Board output is public in public repositories.** The conveyor replaces secrets with `[redacted]` in everything it writes to the board, in the artifacts it commits to the repository, and in its log. It recognizes common token formats (GitHub, GitLab, Anthropic and OpenAI style `sk-…`, AWS access keys, Slack) and the values of 8 or more characters of variables whose names contain `TOKEN`, `SECRET`, `PASS`, `KEY`, or `CREDENTIAL`, from the environment and from `harnesses.*.env` in the settings. Shorter values and other secrets are not recognized, and the code the agent commits is not checked. Keep secrets out of the repository and the agent's reach.
- **Approvals belong to one commit.** An `/approve` or an Approve review counts only for the head commit that was under review. When anyone else pushes to the task branch, the conveyor asks for a new approval, and it merges only that commit. On GitLab, an approval counts only with its "approved this merge request" system note, which gives its time; enable "Remove all approvals when commits are added" in the project's merge request approval settings as well.

## Recommended setup for a repository the conveyor works on

An agent that follows malicious instructions can do everything the credentials on the machine allow: push code, change issues and pull requests, and act on other repositories of the same account. A token with admin rights can also change branch protection. Limit what such an agent can reach:

1. **Run the conveyor as a separate account.** Create a bot user with write (GitHub) or Developer (GitLab) access to this repository only, never admin or Maintainer. Sign `gh` or `glab` in as that user in a separate OS user or a container that has no access to your home directory, keyring, SSH agent, or Docker socket.
2. **Give that account a narrow token.** GitHub: a fine-grained token for this repository with Contents, Issues, Pull requests, and Metadata (add Workflows only when stages change CI files). GitLab: a project access token with the `api` scope and the Developer role. Without `delete_repo` or admin rights, the account cannot delete the repository or change its protection.
3. **Protect the default branch on the server.** Require pull requests and status checks, and give the bot no bypass. For teams, also require an approval from a human reviewer and dismiss stale approvals; then the server, not only the conveyor, stops an unreviewed merge.
4. **Guard executable configuration.** Add `.conveyor/` and `.github/workflows/` (or `.gitlab-ci.yml`) to CODEOWNERS and require code owner review, so a change to hooks, harness commands, or CI needs a human.
5. **Keep publishing credentials elsewhere.** npm, cloud, and deployment credentials never belong in the environment the conveyor runs in.
