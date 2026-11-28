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
