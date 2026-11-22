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
- Wide refactors, formatting passes or dependency bumps (Dependabot opens security updates; other bumps are the maintainer's call)

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

You need [what the README lists](README.md#what-you-need), except that tests don't need Slack, T3 Code or a GitHub login. Intel Macs are fine for development.

```sh
git clone https://github.com/isacssw/serra.git
cd serra
./scripts/install.sh   # checks prerequisites, enables pnpm, installs, then starts `pnpm run setup`
```

Or by hand:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm check       # types for the daemon, app and renderer, then pnpm lint (oxlint, repo rules, unused code)
pnpm test        # node --test tests/*.test.ts; no Slack, launchd or T3 needed
pnpm knowledge   # checks the knowledge template
pnpm app:dev     # build and run the app from the checkout
```

If `pnpm` isn't found after `corepack enable pnpm` (common with nvm, where each Node version has its own bin folder and
corepack can't write a shim to it), run every command as `corepack pnpm …` instead, or run `corepack enable pnpm` again
after switching Node versions.

pnpm can skip Electron's download when it reuses a cached install, most often in a second checkout or a git worktree.
`pnpm app:dev` fetches it if it's missing; for anything else that starts Electron, run
`node node_modules/electron/install.js` once (it does nothing when Electron is already there).

`./scripts/install.sh --check` only checks prerequisites. Tests use temporary profiles, a fake `t3` and a simulated launchd driver.

To try a change against a real bot, use a separate Slack app and profile from the one you rely on, run it in the foreground with `pnpm start --profile …`, and keep your service on its prepared release.

### Run a bot from the checkout, without the app

Everything the app's wizard does is also a command. The examples use the bot ID `friday`.

```sh
pnpm run setup   # asks the same questions as the wizard, creates ~/.local/share/serra/<bot-id>
```

Use `pnpm run setup` and `pnpm run doctor` with `run`: `pnpm setup` and `pnpm doctor` are pnpm's own commands. Setup can also read a file: copy [`examples/profile.json`](examples/profile.json), edit it, and run `pnpm run setup --config my-profile.json --profile "$HOME/.local/share/serra/friday"`.

Then the Slack app: paste the profile's `manifest.json` at [api.slack.com/apps](https://api.slack.com/apps) › **Create New App** › **From a manifest**, install it, and put the `xoxb-` and `xapp-` (`connections:write`) tokens in the profile's `.env`, or in the Keychain: `pbpaste | pnpm bot secrets set SLACK_BOT_TOKEN --keychain --profile …` ([tokens](docs/configuration.md#tokens-and-precedence)). Then:

```sh
pnpm run doctor --profile "$HOME/.local/share/serra/friday"      # PASS/FAIL per check; --offline skips the Slack, GitHub and T3 connections
pnpm start --profile "$HOME/.local/share/serra/friday"           # run in the foreground; Ctrl-C stops it
pnpm bot interview --profile "$HOME/.local/share/serra/friday"   # the knowledge interview
```

To run it in the background as a launchd service:

```sh
pnpm bot prepare  --profile "$HOME/.local/share/serra/friday"   # snapshot the code into releases/, install, check
pnpm bot activate --profile "$HOME/.local/share/serra/friday"   # install and start the service dev.serra.friday
pnpm bot status   --profile "$HOME/.local/share/serra/friday"   # also: restart, stop, rollback
tail -f "$HOME/.local/share/serra/friday/logs/bot.log"
```

The service runs a copy from the profile's `releases/`, so you can keep changing the checkout. To move it to new code: `git pull`, `pnpm install --frozen-lockfile`, then `prepare` and `activate` again. `pnpm bot --help` lists every command; [docs/configuration.md](docs/configuration.md) explains them.

### Update a bot from your checkout

With the app installed, the bot normally follows the app's version from GitHub Releases. To make it follow your checkout instead, set **Settings › Worker › Developer: update from a checkout** to the clone (the profile's `updates` field). Updates then lists new commits on the branch, **Build from checkout** makes a bot build from it, **Restart bot on it** switches to it, and **Undo last switch** goes back. The app itself still updates from Releases. See [app updates](docs/app/install.md#updates).

### Build the app

```sh
pnpm app:package                                            # release/Serra-<version>-arm64.dmg
release/mac-arm64/Serra.app/Contents/MacOS/Serra --smoke   # opens every screen and quits
```

For an Intel Mac: `pnpm app:build && pnpm exec electron-builder --mac --x64`. Releases are cut as in [docs/releasing.md](docs/releasing.md). More: [docs/app/install.md](docs/app/install.md).

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

`pnpm check` enforces most of them, and fails when a PR changes what the gates enforce beyond removing an exception (a change the maintainer agreed to sets the fingerprint it prints): erasable TypeScript only, `.ts` extensions, no unhandled promises, which folder may import which (see [AGENTS.md](AGENTS.md)), and no unused code. CI also scans for secrets. The rest:

- Never commit real Slack IDs, names, local paths or screenshots of a real workspace. Use the placeholders already in the tests (`U0123456789`, `xoxb-1111-2222-fixturevalue`, `/Users/you/…`, `acme/project`).
- Templates under `templates/` must stay generic: no one's personal knowledge or workflow.
- Update the README or `docs/` when behaviour a user sees changes, and add a line to `CHANGELOG.md`.

## How a PR gets in

`main` is protected: nobody pushes to it directly, the maintainer included.

1. Fork the repository and branch off `main`, with a branch name that follows [Naming](#naming).
2. Open a PR with a [valid title](#naming) and fill in the template.
3. Three checks must pass: `check` (`pnpm check`, a secret scan, `pnpm test`, `pnpm knowledge`, the installer's `--help`), `app` (packages the app and smoke-tests it) and `title`. A first-time contributor's run waits for the maintainer to approve it.
4. The PR needs the code owner's approval, every review conversation resolved, and a branch that is up to date with `main` (use **Update branch**). A new push dismisses earlier approvals.
5. It lands as one squash commit whose message is the PR title and description, and the branch is deleted.

## Naming

Squash merging makes the PR title the commit on `main`, so the title is what matters most.

### PR titles

A [Conventional Commit](https://www.conventionalcommits.org) header, `type(scope): subject`, for example `fix(palette): ignore late close events`. The `title` check enforces the types and the subject rules, and that a `feat` or `fix` adds a `CHANGELOG.md` line (Dependabot's `fix(deps)` and `fix(deps-dev)` excepted). It says what to fix; a title fix needs no push. Scope is optional: the part it touches (`daemon`, `app`, `setup`, `knowledge`, `ci`, `deps`, `release`, …).

### Branch names and commits

Branches are `type/short-kebab-description` with the same types, such as `fix/palette-late-close`; tools keep their own (`dependabot/…`). Commits on a branch can use the title format too, but only the PR title is checked, because the commits are squashed into it.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
