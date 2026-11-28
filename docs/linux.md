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

The app lists the server's profiles once paired. Working with them from the app comes next.
