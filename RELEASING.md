# Releasing

Only the maintainer publishes. npm 2FA is required.

1. On `develop`: update `CHANGELOG.md` (replace "unreleased" with the date) and `version` in `package.json`; run `npm install --package-lock-only`. Commit and push.
2. Wait until CI on `develop` is green.
3. Fast-forward `main`: `git push origin origin/develop:main`. Wait until CI on `main` is green.
4. Tag the commit that CI checked: `git tag -s vX.Y.Z origin/main -m vX.Y.Z` and `git push origin vX.Y.Z`.
5. Publish from a clean checkout of the tag:

   ```bash
   git clone --branch vX.Y.Z --depth 1 git@github.com:phalbohr/conveyor.git /tmp/conveyor-release
   cd /tmp/conveyor-release
   npm ci
   npm publish
   ```

   `prepublishOnly` runs the type check and the tests, `prepack` builds a fresh `dist`.
6. Check the result: `npm view @phalbohr/conveyor version`, then `npm install -g @phalbohr/conveyor` and `conveyor --version`.
7. Create a GitHub release for the tag with the changelog section.

A published version cannot be replaced. For a broken release, publish a fixed patch version and run `npm deprecate @phalbohr/conveyor@X.Y.Z "<reason>"`.
