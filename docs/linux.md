# Run the bot on Linux

The bot runs on Linux without the app, as a systemd user service. The desktop app is macOS only.

## Install

You need Git, the GitHub CLI signed in (`gh auth login`), [T3 Code](https://github.com/pingdotgg/t3code) with its `t3`
command, and the repository the bot works in. Node isn't needed: the installer adds it for you if it's missing.

```sh
git clone https://github.com/isacssw/serra.git ~/serra
cd ~/serra
./scripts/install.sh
```

The installer:

- uses your Node 24 (or 22.18+) if you have one. Otherwise it downloads Node 24.22.3 from nodejs.org into
  `~/.local/share/serra/runtime`, for you only, and refuses it unless it matches the SHA-256 pinned in the script.
- installs the bot's dependencies (not the app's), adds a `serra` command to `~/.local/bin`, and starts setup.
- never uses sudo, never runs as root, and opens no port. Slack is reached over an outgoing connection only.

`./scripts/install.sh --no-setup` installs without setup; `--check` only checks.

## Check, start and stop

```sh
serra server doctor                                    # this computer: Node, git, gh, T3, agents, disk, systemd
serra secrets --profile ~/.local/share/serra/<bot-id>   # where the Slack tokens come from
serra prepare --profile ~/.local/share/serra/<bot-id>   # build and check a release
serra activate --profile ~/.local/share/serra/<bot-id>  # install and start the service
serra status --profile ~/.local/share/serra/<bot-id>    # also stop, start, restart, rollback
```

The service is `~/.config/systemd/user/dev.serra.<bot-id>.service`. It restarts after a crash and logs to the
profile's `logs/bot.log`.

A user service stops when you log out unless lingering is on. `serra server doctor` says when it's off; turning it
on is one command you run yourself: `sudo loginctl enable-linger $USER`.

Without systemd (WSL, a container), run the bot in the foreground: `pnpm start --profile …`.

## Tokens

Put the Slack tokens in the profile's `.env` (created private, mode 600) or point them at 1Password
(`serra secrets set SLACK_BOT_TOKEN --1password op://vault/item/field --profile …`). The Keychain is macOS only.

## Pair the Mac app

The Mac app can reach the server's profiles through Serra's gateway. It listens only on the server's own
`127.0.0.1` and its [Tailscale](https://tailscale.com) address, over TLS with the server's own certificate. It never
listens on your LAN or the internet, and it needs no root and no firewall change.

```sh
serra server gateway --install   # a systemd user service, dev.serra.gateway (or: serra server gateway, in the foreground)
serra server pair                # a code, three words and the address to type on the Mac
```

On the Mac: **Add… › Server**, type the address and the code, check the three words match what the server shows,
then **They match**. Without Tailscale, pick **Pair over SSH instead** and type the SSH address you already use
(`you@t480`): the app uses your own keys and SSH agent and never asks for a password, then reaches the gateway
through an SSH tunnel.

- A code works once, for 10 minutes, and five wrong tries end it. Nothing secret leaves the Mac before you say the
  words match.
- The Mac keeps its key in the Keychain; the server keeps only a hash of it. `serra server devices` lists the paired
  Macs, and `serra server devices revoke <id or name>` cuts one off on its next call.
- The gateway's files are in `~/.local/share/serra` (`server.json`, `devices.json`, `gateway/`), readable by you only.
  Its log is `gateway/gateway.log`. Neither the code nor a key is ever written there.

Once paired, the server's profiles show in the app's switcher, menubar and **Settings › Profiles**, each ending
`· t480`. **Settings › Servers** shows whether each server is `up` or `offline` (after 15 seconds without an answer,
with **Retry**), the Macs that can reach it (**Revoke** for the others), and **Forget**, which unpairs this Mac and
revokes its key on the server when it can reach it, without deleting anything there. If it couldn't reach the
server, run `serra server devices revoke <name>` there. To add a profile on the server, run `pnpm setup` in Serra's
folder there, or move one from the Mac. Opening a server's profile in the app comes next.

## Move a profile, restore one, and update the server

In the Mac app, a profile's page in **Settings › Profiles** has **Move to t480…**, and a server's profile has
**Move back to this Mac…**. A move:

1. lets running jobs finish (no new one starts; a job waiting for you blocks the move),
2. pauses the bot where it is (its service stops and is set aside, so a reboot doesn't start it),
3. makes a checked backup there,
4. copies every file and checks its SHA-256 on the other side,
5. starts it on the other computer, with its tokens sent over the paired link into that computer's own store,
6. and only then moves the old copy to the Trash (on a server, `backups/.trash`). The backup stays in `backups/`.

The folders the bot works in (its project and repositories) must be on the server too, at the same path or the same
place under your home folder. Locks, the bot's code (`releases/`) and `.env` never travel; the server builds the bot
again from its own checkout. If anything fails before step 5 the bot runs again where it was, unchanged. While a
move is paused, `moves/hold-<profile>.json` beside the profiles keeps the bot from starting; if the Mac goes away
for 10 minutes before step 5, the server starts it again by itself.

The same page lists the profile's backups with **Restore…**: today's copy is backed up first, the backup is checked
against its `manifest.sha256`, and the bot's code and tokens stay as they are.

The server's page shows its Serra version in Diagnostics. When it is older than the app, **Update t480** runs
`serra server update --to <the app's version>` there: it checks out that release's tag from origin (a checkout with
local changes is left alone), installs, restarts the gateway, and goes back to the commit it was on if the new
version doesn't answer. Bots keep running their own release meanwhile. It needs the gateway as a systemd service
(`serra server gateway --install`); otherwise run the same command on the server yourself.
