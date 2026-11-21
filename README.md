<p align="center"><img src="assets/brand/serra-lockup.png" alt="Serra" width="360"></p>

# Serra: your local coding agents, from the chat you already use

Serra is a bridge between your team chat and the coding agents on your Mac. It connects a chat bot to [T3 Code](https://github.com/pingdotgg/t3code), so the agent you already use there (Claude, Codex, …) can take requests from chat. When someone mentions the bot or sends it a DM, Serra starts a T3 thread in a fresh Git worktree of your repository. The coding agent does the work there (answers a question, fixes a bug, opens a draft PR) and its reply goes back to the chat thread. Follow-ups in the thread continue the same T3 conversation.

**Chat channels:** Slack is supported today, and it is the only one in this alpha. Discord, Telegram and others are planned; Serra is being built so the channel is your choice. Everything below sets up Serra with Slack.

Each engineer runs their own bot: their own chat app (a Slack app today), their own machine, their own GitHub login. Settings, tokens, knowledge and job state live in a private **profile** folder outside this checkout.

> **Alpha.** Serra is early software, shared so people can try it locally. Expect rough edges and breaking changes between versions. See [Limits](#alpha-limits) before you point it at a repository that matters.

- [Requirements](#requirements)
- [Chat channels](#chat-channels)
- [Quick start](#quick-start)
- [Run it in the background](#run-it-in-the-background)
- [The desktop app (optional)](#the-desktop-app-optional)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Development](#development)

## Requirements

| What | Why | Check |
|---|---|---|
| macOS (Apple silicon or Intel) | The background service uses launchd; the app is macOS-only. The bot can run in the foreground elsewhere, untested. | `sw_vers` |
| Node.js 24, or 22.18+ | Serra runs its TypeScript directly with Node's type stripping. | `node -v` |
| pnpm 10 (via Corepack, which ships with Node) | Installs dependencies. The install script enables it for you. | `pnpm -v` |
| Git and the GitHub CLI, signed in | The agent commits, pushes and opens PRs as you. | `gh auth status` |
| [T3 Code](https://github.com/pingdotgg/t3code) running, with its `t3` command line (`t3 thread …`, `t3 project …`) | Serra starts and reads T3 threads through it. Default path `~/.t3/bin/t3`. | `~/.t3/bin/t3 thread list --json` |
| A coding provider signed in inside T3 Code (Claude, Codex, …) | T3 runs the actual agent. | Start a thread in T3 by hand |
| Permission to create a Slack app in your workspace | Slack is the chat channel Serra supports today, and each bot is its own Slack app. Ask an admin if app approval is required. | — |

Your target repository must be a Git checkout with a remote (normally `origin` on GitHub), registered as a project in T3 Code (add it in the T3 Code app, or run `~/.t3/bin/t3 project add /path/to/repo`), and have Git `user.name` and `user.email` set.

## Chat channels

| Channel | Status |
|---|---|
| Slack | Supported (Socket Mode, so no public URL to host) |
| Others (Discord, Telegram, …) | Planned, not in this alpha. Tell us which one you want in an issue. |

## Quick start

### 1. Install

```sh
git clone https://github.com/isacssw/serra.git
cd serra
./scripts/install.sh
```

The script checks every prerequisite above and tells you how to fix anything missing, enables pnpm with Corepack if needed, runs `pnpm install --frozen-lockfile`, and then starts the setup questions. It doesn't start the bot or contact Slack. Run `./scripts/install.sh --check` to only check prerequisites.

### 2. Create your bot's profile

Setup asks for:

- **Bot display name** (what people see, e.g. `Friday`) and a **stable ID** (lowercase, e.g. `friday`; used for branch prefixes, the profile folder and the service label).
- **Your name**, your **Slack member ID** (in Slack: click your profile picture → Profile → ⋮ → *Copy member ID*; it looks like `U0123456789`) and your **GitHub login** (detected from `gh`).
- The **absolute path of your repository**, its remote, and the base branch for new worktrees (detected from Git).
- Optional teammate member IDs who may also use the bot, and an optional review channel.

The profile is created at `~/.local/share/serra/<bot-id>` (setup prints the path). The examples below use `friday`; use your own ID. Prefer a file? Copy [`examples/profile.json`](examples/profile.json), edit it, and run `pnpm run setup --config my-profile.json --profile "$HOME/.local/share/serra/friday"`.

> Use `pnpm run setup` and `pnpm run doctor` with `run`: `pnpm setup` and `pnpm doctor` are pnpm's own built-in commands.

### 3. Create the Slack app (your chat channel)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, and pick your workspace.
2. Paste the contents of your profile's `manifest.json` (it is [`manifest.yaml`](manifest.yaml) with your bot's name filled in).
3. **Install to Workspace**. Then from **OAuth & Permissions**, copy the **Bot User OAuth Token** (`xoxb-…`).
4. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope (`xapp-…`).
5. Put both tokens in your profile's `.env`:

   ```sh
   open -e "$HOME/.local/share/serra/friday/.env"
   ```

   Or keep them in the macOS Keychain instead of a file: copy a token, then `pbpaste | pnpm bot secrets set SLACK_BOT_TOKEN --keychain --profile …` (same for `SLACK_APP_TOKEN`; see [docs/configuration.md](docs/configuration.md#tokens-and-precedence)).
6. In Slack, invite the bot to a test channel: `/invite @friday`.

The manifest uses Socket Mode, so there is no public URL to host. It requests these bot scopes:

| Scope | Used for |
|---|---|
| `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history` | Reading mentions, DMs and the threads the bot is in |
| `chat:write`, `reactions:write` | Replying, and the 👀 acknowledgment |
| `assistant:write` | Slack's “Looking into it” status and Agent view |
| `files:read`, `files:write` | Images and files in requests and replies |
| `users:read`, `channels:read`, `groups:read`, `mpim:read` | Showing names instead of IDs, and checking the owner |

### 4. Check everything

```sh
pnpm run doctor --profile "$HOME/.local/share/serra/friday"
```

Doctor prints PASS or FAIL with a reason for each check: Node, tokens, profile storage, knowledge and brief, the Git repository and base branch, Git author, the T3 executable, the GitHub CLI, the T3 server and project, your GitHub account, and the Slack bot token. It never starts a worker or posts anything. Add `--offline` to skip the network checks (T3 server, GitHub, Slack) while you are still setting up.

### 5. Try it

```sh
pnpm start --profile "$HOME/.local/share/serra/friday"
```

When the log says the bot is up, ask it something in your test channel: `@friday what does this repository do?`. You should see 👀 on your message, then an answer in the thread. Reply in the thread to continue. Stop it with Ctrl-C.

### 6. Teach it how you work (optional)

```sh
pnpm bot interview --profile "$HOME/.local/share/serra/friday"
```

This starts a T3 thread that interviews you, one question at a time, about your role, workflows and limits. Each summary you confirm becomes a proposal under `knowledge/proposals/` for you to review in the app's Proposals screen (`pnpm bot proposals --profile …` lists them). New profiles start with an empty knowledge index. See [docs/knowledge-interview.md](docs/knowledge-interview.md).

## How it behaves in Slack

- 👀 means it saw your message; it goes away when the bot answers. Slack's loading indicator shows while it works, and a long job gets one “Still on it” line.
- Clarifying questions appear in the thread with buttons. The requester or the owner can answer there.
- Messages sent close together reach the agent as one turn. A message that mentions other people but not the bot isn't treated as a request.
- The owner is pinged only when the bot is blocked on something only they can do (a line starting `Needs owner:`).
- By default it opens **draft** PRs, never merges, never force-pushes, and won't run anything that changes production or a shared system. The rules are in the profile's `brief.md` and `policy.md`.

## Run it in the background

To keep the bot running after you close the terminal (and across logins), prepare a release and activate it as a launchd service. Stop any foreground copy first.

```sh
pnpm bot prepare  --profile "$HOME/.local/share/serra/friday"   # snapshot the code, install, check; changes nothing running
pnpm bot activate --profile "$HOME/.local/share/serra/friday"   # install and start the launchd service dev.serra.friday
```

Day to day:

```sh
pnpm bot status   --profile "$HOME/.local/share/serra/friday"
pnpm bot restart  --profile "$HOME/.local/share/serra/friday"
pnpm bot stop     --profile "$HOME/.local/share/serra/friday"
pnpm bot rollback --profile "$HOME/.local/share/serra/friday"   # back to the previous release
tail -f "$HOME/.local/share/serra/friday/logs/bot.log"
```

The service runs a copy of the code from the profile's `releases/` folder, so you can keep changing this checkout. To update: `git pull`, `pnpm install --frozen-lockfile`, then `prepare` and `activate` again. Nothing updates automatically.

## The desktop app (optional)

Serra also has a macOS menubar app for watching jobs, editing knowledge, managing tokens and running diagnostics. With no profile it opens a first-run wizard that does steps 2–4 above and installs the service. Build it from this checkout (it isn't signed or notarized yet):

```sh
pnpm app:package
open release/*.dmg
```

Drag Serra to Applications. The first launch is blocked by Gatekeeper: open **System Settings → Privacy & Security** and click **Open Anyway**. See [docs/app/install.md](docs/app/install.md).

## Configuration

Everything about a bot lives in its profile folder:

| File | What it holds |
|---|---|
| `profile.json` | Bot name and ID, owner, repository, allowed users, extra repositories, alert triggers |
| `.env` or `secrets.json` | The Slack tokens (or where to read them: Keychain, 1Password) |
| `brief.md`, `policy.md` | The instructions every worker gets, and your narrower rules |
| `knowledge/` | Your notes, indexed for the worker |
| `state.json`, `logs/` | Job state and logs |

[docs/configuration.md](docs/configuration.md) covers every field, extra repositories, automatic alert investigations, attachments, and all `pnpm bot` commands. [`.env.example`](.env.example) shows the token variables.

## Alpha limits

- Slack is the only chat channel so far. Other channels are planned; profile fields like the owner's Slack member ID may change shape when they arrive.
- macOS only for the service and the app. One bot per Slack app; one profile per bot.
- The bot acts with **your** GitHub credentials and your T3 Code provider. Anyone on the allowed list can ask it to read your repository and open PRs as you. Keep the allowed list short.
- Your machine and T3 Code must stay on for the bot to answer. Messages sent while it is down aren't replayed.
- The app is unsigned and has no auto-update.
- Formats (profile, state) may change between alpha versions; check the [CHANGELOG](CHANGELOG.md) before updating.

## Troubleshooting

Run `pnpm run doctor --profile …` first: most problems show up as a FAIL with the fix in its message.

- **`pnpm: command not found`**: run `corepack enable pnpm` (or use `corepack pnpm …`).
- **`pnpm setup` or `pnpm doctor` printed pnpm's own output, or "Unknown option: 'profile'"**: add `run`: `pnpm run setup`, `pnpm run doctor`.
- **Tokens FAIL / `invalid_auth`**: both tokens must come from the same Slack app; the bot token starts `xoxb-`, the app token `xapp-` with `connections:write`. Reinstall the app after changing scopes.
- **No reply in Slack**: is the bot invited to the channel? Is your member ID the owner or on `allowedUsers`? Check `logs/bot.log`.
- **T3 connection and project FAIL**: start T3 Code, and register the exact repository path from `profile.json` as a project. If `t3` lives elsewhere, set `"t3Bin"` in `profile.json` to its absolute path.
- **GitHub account FAIL**: `gh auth login` as the login in `profile.json`.
- **Base branch FAIL**: `git fetch` in your repository, or set `project.baseRef` to a branch that exists.
- **Images or files ignored**: your Slack app needs `files:read`; update its manifest and reinstall it.
- **Service stops at start, naming `~/Documents`, `~/Desktop` or `~/Downloads`**: macOS asks before a background service reads those folders. Allow `node` under System Settings → Privacy & Security → Files and Folders, or keep the repository somewhere else (e.g. `~/code`).
- **Already running**: a second copy for the same profile or Slack app is refused. Use `pnpm bot status` and `pnpm bot stop`.

## Uninstall

```sh
pnpm bot stop --profile "$HOME/.local/share/serra/friday"         # if you activated the service
rm -f ~/Library/LaunchAgents/dev.serra.friday.plist
rm -rf "$HOME/.local/share/serra/friday"                          # the profile: tokens, knowledge, state, releases
security delete-generic-password -s dev.serra.friday -a SLACK_BOT_TOKEN   # only if you used the Keychain
security delete-generic-password -s dev.serra.friday -a SLACK_APP_TOKEN
```

Then delete this checkout. If you installed the app, quit it, move it to the Trash and remove `~/Library/Application Support/serra/`. Finally, delete the Slack app at [api.slack.com/apps](https://api.slack.com/apps). Worktrees the bot made stay in your repository; list them with `git worktree list` and remove them with `pnpm bot cleanup --profile …` or `git worktree remove`.

## Development

```sh
pnpm check       # TypeScript: daemon, app main process, renderer
pnpm test        # node --test, about 500 tests; no Slack, launchd or T3 needed
pnpm knowledge   # checks the knowledge template
pnpm app:dev     # build and run the app from the checkout
```

Tests use temporary profiles, a fake `t3` and a simulated service driver. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

Serra is released under the [MIT License](LICENSE). It isn't affiliated with Slack, T3 Code or any other chat or agent vendor.
