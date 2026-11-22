# AGENTS.md

Serra turns chat requests into T3 Code threads. `src/` is the daemon, CLI and services; `app/` is the Electron app.
Rules a tool checks are left out here; `pnpm check` and CI tell you. Humans: [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm check`: types for the three projects, then `pnpm lint` (oxlint type-aware, `scripts/lint-repo.ts`, knip). About 5 s.
- `pnpm test`: `node --test tests/*.test.ts`, about 35-60 s; no Slack, T3 or network.
- `pnpm app:dev` runs the app; `pnpm app:package`, then `release/mac-arm64/Serra.app/Contents/MacOS/Serra --smoke`.
- Before a PR: `pnpm check && pnpm test`. CI adds a gitleaks scan, the packaged-app smoke test and the `title` check.

## Layers (enforced by `.oxlintrc.json`)

- `src/` runs in plain Node and never imports `app/`, Electron or React. `src/index.ts` starts the daemon,
  `src/manage.ts` is `pnpm bot`, `src/contracts.ts` holds the types the app shares.
- `app/main/` is the Electron main process: IPC handlers that call `src/`. It never imports renderer code.
- `app/renderer/` is browser code: no Node or Electron values, `app/main` only through `import type`, and values from
  `src/` only from the pure modules listed in `.oxlintrc.json`. Everything else goes through `window.serra`, typed by
  `SerraApi` in `app/main/bridge.ts`.
- `*.logic.ts` is the pure, tested half of a screen or service: no React, Electron or `node:` values. Put logic there.

## Rules the tools don't check

- Test what a user or caller sees, not the source text. A rule about the repo itself goes in `scripts/lint-repo.ts`.
- Use only the placeholders the tests already use: `U0123456789`, `xoxb-1111-2222-fixturevalue`, `/Users/you/…`,
  `acme/project`. Tokens and home folders are checked; Slack IDs and names are on you.
- A change a user would notice updates `README.md` or `docs/` (the `title` check enforces the `CHANGELOG.md` line).

## PRs

- One problem per PR. Title `type(scope): subject` and branch `type/short-name`: [CONTRIBUTING.md › Naming](CONTRIBUTING.md#naming).
  The `title` check enforces the title. Say in the description which agent and model did the work.

## Never

- Never push to `main`, merge, force-push, tag, publish a release or change repository settings.
- Never commit tokens, `.env`, `secrets.json`, a profile, or screenshots of a real workspace.
- Never add a dependency, or weaken a lint rule, check or test to get green, without the maintainer asking. `pnpm lint`
  fails on any gate change but removing an exception; a change the maintainer asked for sets the fingerprint it prints.
