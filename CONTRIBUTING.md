# Contributing to Serra

Thanks for trying Serra. It is an alpha with one maintainer, so review time is the bottleneck, not ideas or code. Reviewing a PR usually takes more effort than writing it. The rules below keep that manageable.

The most useful things you can send, in order:

1. **Bug reports from real installs.** See [Reporting a problem](#reporting-a-problem).
2. **Help closing things.** Point out duplicates, say when an open bug no longer happens on the latest version, and test open PRs. A comment on an existing PR is always better than a second PR for the same thing.
3. **Bug fix PRs.** See [Rules for a PR](#rules-for-a-pr).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go to [SECURITY.md](SECURITY.md), never to a public issue.

## What we don't take as unsolicited PRs

Serra has a clear direction, and these change it. Open an issue to discuss them instead. A PR for one of them without a maintainer asking for it will be closed.

- New features or changes to how Serra behaves, even when the PR calls them a fix
- New chat channels (Discord, Telegram and others are planned; the design comes first)
- New coding providers or ways of talking to T3 Code
- UI overhauls of the app
- Architecture rewrites, plugin systems, or support for platforms other than macOS
- Wide refactors, formatting passes or dependency bumps (Dependabot handles those)

## Reporting a problem

Search the open and closed issues first. Then open an issue with the **Bug report** template, one problem per issue. Include the output of `pnpm run doctor --profile …` and the relevant lines of `logs/bot.log`. Before pasting, remove tokens, Slack IDs, names, repository paths and anything from your knowledge pages you don't want public. Never paste the contents of `.env` or `secrets.json`.

Ideas go in a **Feature request** issue. Describe the problem you have, not only the solution.

## Rules for a PR

These apply to every PR from outside, drafts included. A PR that follows them can still be closed: a review or a merge isn't owed.

### Fix a bug

A PR should fix a bug: a crash, a regression, something that doesn't work the way the README or `docs/` say, or a real performance problem. A small fix for an obvious bug needs no issue. For anything larger, link the issue that shows the bug. If the maintainer asked you for a PR that isn't a bug fix, link that request.

### One problem per PR

Fix one problem, and include everything that fix needs: code, tests, docs and a `CHANGELOG.md` line if a user would notice. Cleanups, refactors and a second fix go in their own PRs.

### Show that it works

Say how you found the bug, how you checked the fix, and what you saw. "Tests pass" on its own isn't evidence. For a change in the app, add before and after screenshots to the PR description (upload them, don't commit them, and don't show a real workspace).

If a coding agent wrote the change, say which one and which model. That's fine; it just helps review.

### Two open PRs per person

Keep at most two PRs open at a time. Get one merged or closed before you open another.

### Keep it mergeable

A PR that conflicts with `main` gets the `needs-rebase` label. If it still conflicts after 14 days with no activity, it is closed.

### When a PR is closed

A PR that breaks a rule gets a comment saying which one and how to fix it, and the `triage:closing` label. It is closed a few days later unless you reply or push. After that, fix it and comment, or open a focused replacement that links the old PR.

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

## Code rules

- Node runs the TypeScript directly with type stripping, so use only erasable syntax (no enums, namespaces or parameter properties) and include the `.ts` extension in imports.
- Never commit real tokens, Slack IDs, names, local paths or screenshots of a real workspace. Use the placeholders already in the tests (`U0123456789`, `xoxb-1111-2222-fixturevalue`, `/Users/you/…`, `acme/project`).
- Templates under `templates/` must stay generic: no one's personal knowledge or workflow.
- Update the README or `docs/` when behaviour a user sees changes, and add a line to `CHANGELOG.md`.

## How a PR gets in

`main` is protected: nobody pushes to it directly, the maintainer included.

1. Fork the repository and branch off `main`.
2. Open a PR and fill in the template.
3. CI (`check`) runs `pnpm check`, `pnpm test`, `pnpm knowledge` and the installer's `--help` on macOS. A first-time contributor's run waits for the maintainer to approve it.
4. The PR needs the code owner's approval, every review conversation resolved, and a branch that is up to date with `main` (use **Update branch**). A new push dismisses earlier approvals.
5. It lands as one squash commit, and the branch is deleted.

### PR titles

The PR title and description become the commit on `main`. Use a conventional commit title in plain language that says what changes for a user, for example `fix(daemon): the bot keeps working when the knowledge index runs over its cap` or `docs: explain how to rotate the Slack tokens`. Types: `fix`, `feat`, `docs`, `test`, `chore`. Scopes: `daemon`, `app`, `setup`, `knowledge`, `ci`, or none. Commits inside the PR can be as messy as you like.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
