# Contributing to Serra

Thanks for trying Serra. It is an alpha, so bug reports from real installs are the most useful thing you can send.

## Reporting a problem

Open an issue with the **Bug report** template. Include the output of `pnpm run doctor --profile …` and the relevant lines of `logs/bot.log`. Before pasting, remove tokens, Slack IDs, names, repository paths and anything from your knowledge pages you don't want public. Never paste the contents of `.env` or `secrets.json`.

Security problems go to [SECURITY.md](SECURITY.md), not to a public issue. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need the [requirements](README.md#requirements) from the README, except that tests don't need Slack, T3 Code or a GitHub login.

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm check   # TypeScript for the daemon, the app main process and the renderer
pnpm test    # node --test tests/*.test.ts
```

To try a change against a real bot, use a separate Slack app and profile from the one you rely on, run it in the foreground with `pnpm start --profile …`, and keep your service on its prepared release.

## Layout

| Path | What |
|---|---|
| `src/` | The daemon and CLI (`index.ts` starts the bot, `manage.ts` is `pnpm bot`, `setup.ts`, `doctor.ts`) |
| `app/` | The Electron app: `main/` (bridge to `src/`), `preload.ts`, `renderer/` (React) |
| `templates/` | What a new profile is seeded with: brief, interview, starter knowledge, Slack app manifest (the only chat channel so far) |
| `tests/` | `node --test` suites; they use temporary profiles, a fake `t3` and a simulated launchd driver |
| `scripts/qa/` | Optional Playwright driver for the app, against a throwaway profile in `/tmp/serra-qa` |
| `docs/` | Configuration, knowledge interview and app notes |

## Pull requests

`main` is protected: nobody pushes to it directly, including the maintainer. Every change comes in as a pull request.

1. Fork the repository (or branch, if you have access) and make your change on a branch off `main`.
2. Open a PR and fill in the template. For a larger change, open an issue first so we can agree on the approach.
3. CI (`check`) runs `pnpm check`, `pnpm test`, `pnpm knowledge` and the installer's `--help` on macOS. A first-time contributor's run waits for the maintainer to approve it.
4. The PR needs an approving review from the code owner, all review conversations resolved, and a branch that is up to date with `main` (use **Update branch**). New pushes dismiss earlier approvals.
5. It lands as a single squash commit, and the branch is deleted.

### Commits and PR titles

The PR title and description become the commit on `main`, so write them for someone reading `git log` later: a plain sentence about what changes for a user (`Keep the bot working when the knowledge index runs over its cap`), and a description that says why. A `docs:` prefix is fine for documentation-only changes. Commits inside the PR can be as messy as you like.

### What makes a PR easy to merge

- Keep each PR to one change, with tests for new behaviour. `pnpm check` and `pnpm test` must pass.
- Node runs the TypeScript directly with type stripping, so use only erasable syntax (no enums, namespaces or parameter properties) and include the `.ts` extension in imports.
- Never commit real tokens, Slack IDs, names, local paths or screenshots of a real workspace. Use the placeholders already in the tests (`U0123456789`, `xoxb-1111-2222-fixturevalue`, `/Users/you/…`, `acme/project`).
- Templates under `templates/` must stay generic: no one's personal knowledge or workflow.
- Update the README or `docs/` when behaviour a user sees changes, and add a line to `CHANGELOG.md`.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
