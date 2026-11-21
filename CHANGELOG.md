# Changelog

Serra follows [Semantic Versioning](https://semver.org) once it reaches 1.0. Until then, any alpha may change the profile or state format; such changes are called out here.

## Unreleased

First public alpha, for trying Serra locally on macOS. Serra bridges a chat app to your local coding agents; this alpha supports one chat channel, Slack.

- Slack channel: mentions and DMs become T3 Code threads in fresh Git worktrees; replies, clarifying questions (with buttons), images and files go back to the Slack thread.
- Private per-bot profiles outside the checkout: settings, tokens (`.env`, Keychain or 1Password), brief and policy, knowledge, state and logs.
- `pnpm run setup` and `./scripts/install.sh` for a new bot; `pnpm run doctor` to check the configuration, T3, GitHub and Slack.
- Background service under launchd with prepare, activate, status, restart and rollback.
- Knowledge interview and a proposals queue for teaching the bot how you work.
- Automatic investigations of messages in configured alert channels.
- `updates` in profile.json (Settings › Worker › Update source): the Serra checkout and branch that Updates counts new commits in and Prepare copies from, so a packaged app can follow the repository.
- macOS menubar app (built locally, unsigned): first-run wizard, Jobs, Knowledge, Brief and policy, Settings, Secrets, Tools, Updates and Diagnostics.
- Tools (app and `pnpm bot tools`), read-only: each provider's MCP servers from `claude mcp list` and `codex mcp list` (claude.ai connectors and plugins included, with their status), the command-line tools on your Mac (installed, version, signed in), and recommended services with commands to copy. A comment after `enabled = false` in Codex's config no longer reads as on.
- Releases are cut in CI: a release PR raises the version and dates this changelog, and merging it tags the commit and publishes a GitHub Release with the app (docs/releasing.md). CI also builds the app on every PR.
