# QA driver

Drives the real Electron app with Playwright's `_electron` against a throwaway profile. Each numbered script covers one area of the app (first run, wizard, Jobs, Knowledge, Settings, Updates, Diagnostics, the packaged build).

Everything lives in `/tmp/serra-qa` (short on purpose: the status socket path must fit in 104 bytes). The app runs with its own `--user-data-dir` and a scratch `HOME` there (`/tmp/serra-qa/home`, with only `~/Library/Keychains` linked in), so it never finds, reads or changes your real profiles, T3 settings or app prefs.

```sh
scripts/qa/setup.sh                 # playwright-core, the fake t3, a clone of this repo as the bot's project
corepack pnpm app:build
scripts/qa/run-all.sh               # every scripted case; logs in /tmp/serra-qa/logs, screenshots in /tmp/serra-qa/shots
scripts/qa/cleanup.sh               # removes the two fake Keychain items and /tmp/serra-qa
```

`30-packaged` also needs `pnpm app:package` first. Each script can run on its own (`node scripts/qa/15-settings.mjs`) once `run-all.sh` has made the profile.

What is fake and what is real:

- **T3**: `fake-t3.cjs` stands in for the `t3` CLI (the profile's `t3Bin`). It records calls in `/tmp/serra-qa/t3-calls.jsonl` and never starts real work. The real T3 connection is checked separately with `pnpm run doctor`.
- **The daemon**: `fake-daemon.ts` serves the real status socket (`src/status-socket.ts`) for the profile, so the header, menubar, badges and notifications see the same messages a running bot sends. Commands go on its stdin.
- **Slack**: never contacted with a real token. `03-wizard-tokens` stores two obviously fake tokens (`xoxb-qa-canary-…`, `xapp-qa-canary-…`) in the login Keychain under `dev.serra.qa-bot`; their Check calls Slack with them and gets `invalid_auth`. Nothing is posted anywhere.
- **launchd**: never changed. Install and Activate stop at the Slack check, and Restart reports that the service isn't installed.
- **Menubar and notifications**: the scripts record what the app hands to Electron's `Tray` and `Notification` (patched in the main process after launch). Whether macOS then shows them is a manual check.
