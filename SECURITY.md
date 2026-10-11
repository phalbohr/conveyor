# Security

## Report a vulnerability

Report vulnerabilities privately through [GitHub security advisories](https://github.com/phalbohr/conveyor/security/advisories/new). Do not open a public issue. You get an answer within 7 days.

## Supported versions

Only the latest release gets security fixes.

## Trust model

The conveyor runs coding harnesses on your machine, as your user. Know these limits before you run it:

- **Harnesses have your permissions.** Claude stages run with `permission_mode: bypassPermissions` by default: the harness can read and change anything your user can, including git, `gh`, and `glab` credentials. The conveyor removes board tokens from the harness environment, but the harness can still reach credentials in the keyring or in files. Limit the harness with `permission_mode` and the allow rules in the repository's `.claude/settings.json`, or run the conveyor in a container or under a separate user with a token for that board only.
- **Task text is a prompt.** Everything in a task, its comments, and the repository goes into the prompt of the harness. The conveyor takes only tasks whose author has write access to the repository, and it reads comments, reviews, commands, workpads, and artifacts only from users with write access. Users with write access can still steer the harness.
- **The team configuration runs commands.** `hooks` and `harnesses.*.command` in `.conveyor/config.yaml` run on every workstation at the next cycle after a change is pulled. Review changes to `.conveyor/` like code.
- **The conveyor does not replace branch protection.** It merges with your token. Protect the base branch (`board.base_branch`, else the default branch): require pull requests and status checks, and dismiss stale approvals.
- **Board output is public in public repositories.** The conveyor replaces secrets with `[redacted]` in everything it writes to the board, in the artifacts it commits to the repository, and in its log. It recognizes common token formats (GitHub, GitLab, Anthropic and OpenAI style `sk-…`, AWS access keys, Slack) and the values of 8 or more characters of variables whose names contain `TOKEN`, `SECRET`, `PASS`, `KEY`, or `CREDENTIAL`, from the environment and from `harnesses.*.env` in the settings. Shorter values and other secrets are not recognized, and the code the harness commits is not checked. Keep secrets out of the repository and the reach of the harness.
- **Without CI there is no check.** The conveyor merges only after green checks, but a repository without any check (or a GitLab pipeline that is only skipped or manual) merges 5 minutes after the pull request opens. Add CI and require it in branch protection.
- **Several workstations share locks through the board.** Claims and the merge lock are branches; when two workstations break the same stale lock at the same moment, both can hold it for one cycle. Keep heartbeats short enough for your setup and run one conveyor per account.
- **Approvals belong to one commit.** An `/approve` or an Approve review counts only for the head commit that was under review. When anyone else pushes to the task branch, the conveyor asks for a new approval, and it merges only that commit. Exception: when the base branch moved, the conveyor rebases the task branch onto it itself, without new code, and merges after the checks are green, without a new approval. On GitLab, an approval counts only with its "approved this merge request" system note, which gives its time; enable "Remove all approvals when commits are added" in the project's merge request approval settings as well.
- **Run one conveyor per account.** Run only one conveyor per board account at a time. Two machines with the same account see each other's claims as their own and can run the same task twice.

## Recommended setup for a repository the conveyor works on

A harness that follows malicious instructions can do everything the credentials on the machine allow: push code, change issues and pull requests, and act on other repositories of the same account. A token with admin rights can also change branch protection. Limit what such a harness can reach:

1. **Run the conveyor as a separate account.** Create a bot user with write (GitHub) or Developer (GitLab) access to this repository only, never admin or Maintainer. Sign `gh` or `glab` in as that user in a separate OS user or a container that has no access to your home directory, keyring, SSH agent, or Docker socket. Then set `review.count_own_approvals: false`: an `/approve` or approval from the bot account no longer counts, so a harness that follows injected instructions cannot approve its own work.
2. **Give that account a narrow token.** GitHub: the board is a GitHub project, and a fine-grained token cannot reach a project owned by a user. For a user-owned project, use a classic token with the `repo` and `project` scopes. For an organization-owned project, use a classic token with `repo`, `project`, and `read:org`, or a fine-grained token for this repository with Contents, Issues, and Pull requests (read and write), Metadata, Checks, and Commit statuses (read), and the organization permission Projects (read and write). Add Workflows only when stages change CI files. GitLab: a project access token with the `api` scope and the Developer role. Without `delete_repo` or admin rights, the account cannot delete the repository or change its protection.
3. **Protect the base branch on the server** (`board.base_branch`, else the default branch). Require pull requests and status checks, and give the bot no bypass. For teams, also require an approval from a human reviewer and dismiss stale approvals; then the server, not only the conveyor, stops an unreviewed merge.
4. **Guard executable configuration.** Add `.conveyor/` and `.github/workflows/` (or `.gitlab-ci.yml`) to CODEOWNERS and require code owner review, so a change to hooks, harness commands, or CI needs a human.
5. **Keep publishing credentials elsewhere.** npm, cloud, and deployment credentials never belong in the environment the conveyor runs in.
