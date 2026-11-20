# Installing the Serra app

Serra is in alpha. The app is built locally as a `.dmg`. It has no Developer ID signature and isn't notarized, so macOS asks once before the first launch.

The app can set up a new bot or manage one that already runs. Setup connects the bot to Slack, the chat channel Serra supports today. With no profile, it opens on the first-run wizard (below). A bot can still be set up from a checkout with `pnpm run setup` and `pnpm bot activate`, as in the [README](../../README.md). The app doesn't need the checkout to stay in place.

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

Beside it, `Serra.app/Contents/Resources/release-source/` holds the daemon's own code (`src/`, `templates/`, `examples/`, the `docs/*.md` pages, and the original `package.json` and `pnpm-lock.yaml`). Updates › Prepare and Install the service make releases from it: the app folder has only the bundle, and its `package.json` has no devDependencies, so `pnpm install --frozen-lockfile` would refuse it. `pnpm app:build` stages it in `app/out/release-source/`. That copy is frozen at build time and has no git: to follow the repository's new commits from a packaged app, set the profile's `updates.source` to a clone of it (Settings › Worker › Update source, see [configuration](../configuration.md)). Updates and Prepare then use that clone instead.

[`app/main/runtime-files.ts`](../../app/main/runtime-files.ts) lists the files the code reads from disk. `tests/app-package.test.ts` checks that `electron-builder.yml` copies each of them, and `--smoke` checks that they are there in the built app.

## Install

1. Open the `.dmg` and drag **Serra** to **Applications**.
2. Eject the disk image.

To update, quit Serra (menubar icon, or ⌘Q with the window focused), then drag the new version over the old one. App preferences are kept.

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

If macOS says the app **is damaged**, the copy lost its ad-hoc signature (for example after being zipped and unzipped by a tool that drops extended attributes). Use the `xattr` command above, or copy the `.dmg` again.

## Where the app finds the profile

The app reads and writes the bot's profile folder (the one with `profile.json`, `.env` or `secrets.json`, `knowledge/` and `status.sock`). It keeps no copy of the bot's settings. It picks the folder in this order:

1. `--profile /absolute/profile/folder`, or the `BOT_PROFILE` environment variable.
2. The folder saved in the app's preferences.
3. The only profile under `~/.local/share/serra/` (where `pnpm run setup` creates them), when there is exactly one.

Whatever the app starts with is saved in its preferences, so later launches from Finder or the Dock use the same profile. With one profile in the default place, there is nothing to do.

With several profiles, or one somewhere else, start the app once with the folder you want:

```sh
open -a Serra --args --profile "$HOME/.local/share/serra/<bot-id>"
```

Preferences live in `~/Library/Application Support/serra/prefs.json` (`profileDir`). To make the app forget the profile, quit it and remove that file.

Without a profile the window still opens and the header reads **Serra · stopped**; the screens that need a profile say so.

## First-run wizard

Without a profile, the window opens on **Welcome to Serra**, which replaces `pnpm run setup` and the Slack manifest steps. Later it is under **Diagnostics › Setup guide** and in ⌘K. Its five steps can be left and resumed; the list shows which are done, read from the profile's files:

1. **Create the profile**: bot name and ID, your name, Slack member ID and GitHub login, and the repository (its base branch and GitHub name are read from Git). The folder defaults to `~/.local/share/serra/<bot-id>`, and the app remembers it.
2. **Create the Slack app**: **Open Slack** opens Slack's "create an app from a manifest" page with the bot's `manifest.json` filled in. Install the app, copy the `xoxb-` bot token, and generate an app-level `xapp-` token with `connections:write`.
3. **Connect the tokens**: the same cards as the Secrets screen. Keychain stores a pasted value; 1Password keeps it in the vault and the bot reads the reference. **Check** must pass for both.
4. **Confirm the owner**: the member ID is looked up in Slack with the bot token, so a typo shows now rather than when the bot first needs you. The result is kept in `setup.json` (no token).
5. **Install the service**: prepares a release from the app's code, runs every Diagnostics check and only then installs and starts the launchd service. A failing check leaves nothing installed. This needs `pnpm` next to the Node it finds, as Updates › Prepare does.

## Live status

The app shows live status when the daemon for that profile is running: the header and menubar read **Serra · up** with the job counts. The daemon serves it on `status.sock` in the profile (owner only, no network port). When the daemon is stopped the app shows **stopped**, and Restart bot in the menubar starts it through launchd, the same as `pnpm bot restart`.

The app doesn't run the bot. Quitting it leaves the daemon running under launchd.

## Tools the app calls

Opened from Finder, an app gets a short `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not your shell's. The packaged app adds `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`, so the 1Password CLI (`op`) for 1Password secrets is found when it is installed there. Keychain secrets use `/usr/bin/security`, and the bot restart uses `launchctl`, which are always there.

## Uninstall

Quit Serra and move it from Applications to the Trash. Optionally remove `~/Library/Application Support/serra/`. This doesn't touch the bot, its profile or its launchd service; see the README to remove those.
