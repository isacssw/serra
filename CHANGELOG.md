# Changelog

Serra follows [Semantic Versioning](https://semver.org) once it reaches 1.0. Until then, any alpha may change the profile or state format; such changes are called out here.

## Unreleased

## 0.1.0-alpha.3 (2026-11-21)

**Upgrading from alpha.2:** install this one by hand, one last time. Download `Serra-0.1.0-alpha.3-arm64.dmg` below, quit Serra, drag the new Serra to Applications and replace the old copy. From alpha.3 on, Serra updates itself: Settings › Updates finds new releases, and **Restart to update** installs them. After you open alpha.3, the bot moves to the new version on its own once no job is running.

- Updates in the app follow GitHub Releases: it checks for a newer version (pre-releases included while you're on an alpha), shows the release notes, downloads and verifies it against the release's `SHA256SUMS`, and **Restart to update** replaces the app and opens it again (or opens the installer when it can't replace itself). The bot then moves to the new version on its own when no job is running. The commit-based flow is now a developer mode, shown only when Settings › Worker › Developer: update from a checkout is set, with clearer names (Build from checkout, Restart bot on it, Undo last switch). Bot builds record the app version, so the screen shows `0.1.0-alpha.3` instead of a timestamp.
- Updating the bot no longer waits indefinitely for a quiet moment: from **Restart to update** (or when the bot is found behind the app), new requests are held with an hourglass until the bot has restarted, while running jobs finish. Held requests start on the restarted bot. The pause lapses on its own after 30 minutes, so the bot never stays deaf.
- Fixed: Roll back on Updates (and `pnpm bot rollback`) right after setup stopped the bot and removed its service, with nothing to go back to. It is now off until there is an earlier bot.
- Old bot builds in the profile's `releases/` folder are removed after each switch, keeping the current one and the one before it.
- The app is still ad-hoc signed and not notarized: macOS asks once (System Settings › Privacy & Security › Open Anyway). Only an Apple silicon build is published; signing and a universal build are planned for the beta.

## 0.1.0-alpha.2 (2026-11-21)

First public alpha, for trying Serra locally on macOS. Serra bridges a chat app to your local coding agents; this alpha supports one chat channel, Slack.

- Slack channel: mentions and DMs become T3 Code threads in fresh Git worktrees; replies, clarifying questions (with buttons), images and files go back to the Slack thread.
- Private per-bot profiles outside the checkout: settings, tokens (`.env`, Keychain or 1Password), brief and policy, knowledge, state and logs.
- `pnpm run setup` and `./scripts/install.sh` for a new bot; `pnpm run doctor` to check the configuration, T3, GitHub and Slack.
- Background service under launchd with prepare, activate, status, restart and rollback.
- Knowledge interview and a proposals queue for teaching the bot how you work.
- Knowledge › About me: every job's brief carries what you've confirmed about yourself (your `owner/` pages and a one-line roster of `people/`), capped at 4,000 characters, for the audience that will see the reply. Pages say who may hear them with `audience: owner | team | external`; **a page without it is now yours only**, so teammates' briefs leave it out until you share it: About me lists such pages and shares the ones you pick in one step, and Pages has a picker on each page. Off-limits pages come first in About me and are never cut for size (1,500 characters for all of them); outsiders' replies carry a fixed rule that names no internal topic, and teammates' replies one too when your off-limits page is yours only. Each worker reads a snapshot of the pages its audience may hear, and Serra checks who can see a thread right before posting anything the worker wrote: a page taken back since, or a thread Slack can't describe, holds the reply. **After upgrading, a thread already running in a channel or a teammate's DM carries on in a fresh session on its next message, and a reply it finishes is held:** Serra doesn't know which pages it read. The interview asks about people, voice (optional samples) and off-limits topics, and records an audience for each page.
- Knowledge approvals are app-only and bound to what you reviewed: `pnpm bot proposals` lists and shows, workers are told never to promote, and a file edited outside Serra isn't used until you review its diff and accept or restore it in Pages. Merge replaces a page instead of appending, and an approval is refused when the proposal or the page changed since you saw it, or when it would write over a file changed outside Serra. The owner's first message in a thread is marked as the owner's. Existing profiles get the updated brief as a proposal in Brief & policy.
- Knowledge evals: deterministic safety tests in CI and a live, graded knows-you eval on an invented owner (`evals/`).
- Automatic investigations of messages in configured alert channels.
- `updates` in profile.json (Settings › Worker › Update source): the Serra checkout and branch that Updates counts new commits in and Prepare copies from, so a packaged app can follow the repository.
- macOS menubar app: the `.dmg` is attached to this GitHub Release (ad-hoc signed, not notarized: allow it once under System Settings › Privacy & Security › Open Anyway), or build it with `pnpm app:package`. It has a first-run wizard, Jobs, Knowledge, Brief and policy, Settings, Secrets, Tools, Updates and Diagnostics.
- Tools (app and `pnpm bot tools`), read-only: each provider's MCP servers from `claude mcp list` and `codex mcp list` (claude.ai connectors and plugins included, with their status), the command-line tools on your Mac (installed, version, signed in), and recommended services with commands to copy. A comment after `enabled = false` in Codex's config no longer reads as on.
- Releases are cut in CI: a release PR raises the version and dates this changelog, and merging it tags the commit and publishes a GitHub Release with the app (docs/releasing.md). CI also builds the app on every PR.
