# Installing the Serra app

Serra is in alpha. Download the `.dmg` from [GitHub Releases](https://github.com/isacssw/serra/releases) (see the [README](../../README.md#1-get-the-app)), or build it yourself as below. It has no Developer ID signature and isn't notarized, so macOS asks once before the first launch.

The app can set up a new bot or manage one that already runs. Setup connects the bot to Slack, the chat channel Serra supports today. Until setup is done, it opens on setup (below). A bot can still be set up from a checkout with `pnpm run setup` and `pnpm bot activate`, as in [CONTRIBUTING](../../CONTRIBUTING.md#run-a-bot-from-the-checkout-without-the-app). The app doesn't need the checkout to stay in place.

## Build the `.dmg`

On a Mac, in a checkout with dependencies installed (`corepack pnpm install`) and `pnpm` on your `PATH` (`corepack enable`):

```sh
pnpm app:package
```

This runs `pnpm app:build` and then [electron-builder](https://www.electron.build) with [`electron-builder.yml`](../../electron-builder.yml). Output goes to `release/`, which is git-ignored:

| Path | What it is |
|---|---|
| `release/Serra-<version>-arm64.dmg` | The disk image to share |
| `release/mac-arm64/Serra.app` | The app itself, to try before sharing |

The build is for the Mac's own architecture (Apple silicon gives `arm64`). For an Intel Mac, run `pnpm app:build && pnpm exec electron-builder --mac --x64`.

To check a build before sharing it, run its smoke test. It opens the window, checks the bridge and every screen, checks that the files the app reads at run time are in the bundle, and quits:

```sh
release/mac-arm64/Serra.app/Contents/MacOS/Serra --smoke
```

The version shown in the app is `version` in `package.json`, which a release PR raises (see [releasing](../releasing.md)). Release builds are also attached to each [GitHub Release](https://github.com/isacssw/serra/releases).

## What is in the app

`Serra.app/Contents/Resources/app/` is a plain folder, not an asar archive:

| Folder | Why it is there |
|---|---|
| `app/out/` | The bundled main process, preload and renderer (`pnpm app:build`) |
| `templates/`, `examples/` | `src/config.ts` resolves `codeRoot` to this folder, so they sit at the same relative paths as in the checkout |
| `assets/brand/serra-status-*.png` | The menubar icons (APP-11), loaded from `assets/brand` next to `app/` |
| `node_modules/` | Production dependencies only (`@slack/bolt`, `electron-store`) |

Beside it, `Serra.app/Contents/Resources/release-source/` holds the daemon's own code (`src/`, `templates/`, `examples/`, the `docs/*.md` pages, the original `package.json` and `pnpm-lock.yaml`, and `release.json` with the version and commit it was built from). Install the service and the bot's updates make releases from it: the app folder has only the bundle, and its `package.json` has no devDependencies, so `pnpm install --frozen-lockfile` would refuse it. `pnpm app:build` stages it in `app/out/release-source/`.

### Updates

Settings › Updates shows the app's version and looks for a newer one on [GitHub Releases](https://github.com/isacssw/serra/releases) 15 seconds after launch, every 6 hours, and on **Check for updates**. Pre-releases are included while the installed version is one (an alpha); the checkbox on the screen changes that. Nothing downloads until you click **Download**. The download is checked against the release's `SHA256SUMS` and the app inside the disk image must be Serra (`dev.serra.app`) at the expected version with an intact signature; a download that fails is deleted.

**Restart to update** quits Serra, moves the old app aside, puts the new one in its place and opens it. The old copy is kept as `Serra.app.previous` until the new version starts, and put back if the move fails. Serra opens the disk image for you instead (**Open installer**) when it can't replace itself: when it runs from the disk image or a folder macOS moved it to (App Translocation), or when its folder needs an administrator.

The background bot keeps running through the app's update. It then follows the app's version on its own: when no job is running, Serra builds the bot from the new app's code (this needs Node and pnpm, as Install the service does) and restarts it, and puts the previous bot back if the new one doesn't start. While a job runs it waits, and **Update now** restarts it anyway (jobs continue after the restart). So that the wait ends, new work is paused from **Restart to update** (or as soon as the bot is found behind) until the bot has restarted: a request that would start a new job gets an hourglass and starts on the restarted bot, while messages for running jobs still reach them (a reply in a held thread waits behind its request). The bot is restarted only once it confirms that nothing it let in is still starting. A bot from before this change doesn't know about pauses, so the first update to it waits for a quiet moment as before. The pause lapses on its own after 30 minutes; if jobs are still running then, requests flow again for an hour and the bot waits for a quiet moment instead. Old bot builds in the profile's `releases/` folder are removed after each switch, keeping the current one and the one before it.

The app is ad-hoc signed, not notarized, so the checksum is what guards an update: it catches a broken or swapped download, but `SHA256SUMS` comes from the same release. Serra downloads updates itself, so macOS doesn't quarantine them and doesn't ask again.

To work on Serra itself, set Settings › Worker › **Developer: update from a checkout** to a clone of the repository (the profile's `updates`, see [configuration](../configuration.md)). Updates then switches to developer mode: it lists the new commits on the branch, **Build from checkout** makes a bot build from the clone, **Restart bot on it** switches the bot to that build, and **Undo last switch** goes back to the one before (shown only when there is one). The app's own updates still come from GitHub Releases. **Follow app updates** on Updates leaves developer mode (it clears the setting after copying `profile.json` to the profile's `backups/`). A packaged app clears an update source that can't work, such as a folder that's gone or holds neither git nor Serra's code, the same way, and says so on Updates.

[`app/main/runtime-files.ts`](../../app/main/runtime-files.ts) lists the files the code reads from disk. `tests/app-package.test.ts` checks that `electron-builder.yml` copies each of them, and `--smoke` checks that they are there in the built app.

## Install

1. Open the `.dmg` and drag **Serra** to **Applications**.
2. Eject the disk image.

From alpha.3 on, Serra updates itself (see [Updates](#updates)). To install by hand (alpha.2 or older, or a build of your own), quit Serra (⌘Q with its window focused; the menubar icon has no Quit), then drag the new version over the old one. App preferences and the bot's profile are kept.

## First launch past Gatekeeper

The app isn't notarized, so macOS blocks the first launch of a copy that came from a browser, Slack, AirDrop or email.

**macOS 15 (Sequoia) and later:**

1. Open Serra from Applications. macOS says it can't check Serra for malware. Click **Done** (not Move to Trash).
2. Open **System Settings → Privacy & Security**. Near the bottom, next to "Serra was blocked to protect your Mac", click **Open Anyway**.
3. Confirm with **Open Anyway** and your password or Touch ID.

**macOS 14 (Sonoma) and earlier:** Control-click Serra in Applications, choose **Open**, then **Open** again.

You only do this once per installed copy. A new build dragged over the old one asks again.

From a terminal you can instead remove the quarantine flag, which skips the prompt:

```sh
xattr -dr com.apple.quarantine /Applications/Serra.app
```

If macOS says the app **is damaged**, download the `.dmg` again, check it against `SHA256SUMS`, and copy Serra from it again. A copy that was zipped and unzipped by a tool that drops extended attributes can lose its ad-hoc signature this way. If a fresh, verified copy still says so, use the `xattr` command above.

## Where the app finds the profile

The app reads and writes the bot's profile folder (the one with `profile.json`, `.env` or `secrets.json`, `knowledge/` and `status.sock`). It keeps no copy of the bot's settings. It picks the folder in this order:

1. `--profile /absolute/profile/folder`, or the `BOT_PROFILE` environment variable.
2. The folder saved in the app's preferences.
3. The only profile under `~/.local/share/serra/` (where `pnpm run setup` creates them), when there is exactly one.

Whatever the app starts with is saved in its preferences, so later launches from Finder or the Dock use the same profile. With one profile in the default place, there is nothing to do.

With several profiles, setup asks which one to use, and **Open another profile…** picks one somewhere else. Both are saved the same way. To pin a profile from the command line instead (setup then can't switch it):

```sh
open -a Serra --args --profile "$HOME/.local/share/serra/<bot-id>"
```

Preferences live in `~/Library/Application Support/serra/prefs.json` (`profileDir`). To make the app forget the profile, quit it and remove that file.

Without a profile the app opens on setup. Skipped, every screen that needs a profile shows the same **Finish setup** state with a way back.

## Setup

Until every step is done, the window opens on setup, a full-window flow without the sidebar, which replaces `pnpm run setup` and the Slack manifest steps. It is also the sidebar's **Finish setup** row (with a ring of the steps done), **Serra › Set Up Serra…** in the menu bar, **Diagnostics › Setup** and ⌘K. Each step reads its state from the profile's files, so setup can be left at any point and resumed; the profile form is saved in the app's preferences as it's typed.

The first screen looks for what already exists: the profile in use and every profile under `~/.local/share/serra/`. For each it shows the profile, where the Slack tokens are (`.env`, Keychain or 1Password; presence only, and 1Password isn't opened), whether the owner was confirmed and whether the service is installed (an activated release or a launchd plist) and running (it answers on `status.sock`). It then resumes at the first missing step. With several profiles it asks which one.

1. **You & repo**: your name, GitHub login and Slack member ID, the repository folder (its base branch and GitHub name are read from Git), and the bot's name. The ID, remote, profile folder and T3 CLI are under **More options**. The folder defaults to `~/.local/share/serra/<bot-id>`, and the app remembers it.
2. **Connect Slack**: **Create in Slack** opens Slack's "create an app from a manifest" page with the bot's `manifest.json` filled in. Paste the `xoxb-` bot token and the `xapp-` app-level token (`connections:write`); each is stored in the Keychain and checked with Slack. Tokens already in `.env` or the Keychain are checked as the step opens and shown for you to confirm; 1Password ones wait for **Check**, so nothing asks to unlock. **Use 1Password or .env instead** shows the same editors as the Secrets screen.
3. **Confirm you**: the owner's member ID is looked up in Slack with the bot token as the step opens, so a typo shows now rather than when the bot first needs you. The result is kept in `setup.json` (no token).
4. **Install and start**: prepares a release from the app's code, runs every Diagnostics check and only then installs and starts the launchd service, then waits until the bot answers. A failing check leaves nothing installed. This needs `pnpm` next to the Node it finds, as Updates › Prepare does.

## Live status

The app shows live status when the daemon for that profile is running: the header and menubar read **Serra · up** with the job counts. The daemon serves it on `status.sock` in the profile (owner only, no network port). When the daemon is stopped the app shows **stopped**, and Restart bot in the menubar starts it through launchd, the same as `pnpm bot restart`.

The app doesn't run the bot. Quitting it leaves the daemon running under launchd.

## Tools the app calls

Opened from Finder, an app gets a short `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not your shell's. The packaged app adds `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`, so the 1Password CLI (`op`) for 1Password secrets is found when it is installed there. Keychain secrets use `/usr/bin/security`, and the bot restart uses `launchctl`, which are always there.

## Uninstall

Quit Serra and move it from Applications to the Trash. Optionally remove `~/Library/Application Support/serra/`. This doesn't touch the bot, its profile or its launchd service; see the [README](../../README.md#uninstall) to remove those.
