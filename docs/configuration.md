# Bot profiles

A profile connects one bot to one chat channel. Slack is the only channel today, so the Slack-specific fields below (member IDs, channel IDs, tokens) are the channel settings; other channels will add their own.

Use one private profile per bot, outside the code checkout. `pnpm run setup` creates it. Select it with `--profile /absolute/folder` or `BOT_PROFILE=/absolute/folder`. The bot and doctor refuse to start without one; there are no built-in owner defaults.

## Files

| File | Purpose |
|---|---|
| profile.json | Identity, ownership, repositories, allowlist, optional review posting and message triggers |
| .env | SLACK_APP_TOKEN and SLACK_BOT_TOKEN |
| secrets.json | Where each token comes from (Keychain or 1Password), when Slack last accepted it, and the Slack workspace URL. Never a token value |
| brief.md | Worker instructions, generated from the shared template for new profiles |
| policy.md | Owner's confirmed workflow choices, read by the generic brief |
| proposed/ | Brief and policy rewrites waiting for the owner: one folder each, with a brief.md and/or policy.md. The app's Brief & policy screen compares and applies them |
| knowledge/ | Indexed owner knowledge, drafts, and proposals. Starts from the empty template in templates/knowledge |
| onboarding.md | How to start the knowledge interview |
| manifest.json | Slack app manifest with the chosen name |
| state.json | Slack-thread to T3-thread mappings and last posted run IDs |
| tasks.json | Tasks started from the app, `pnpm bot task` or `pnpm bot interview` without Slack: their T3 threads, so they show in Jobs. Written only by the app and the CLI, never by the daemon |
| releases/ | Prepared code snapshots and installed production dependencies |
| prepared.json | The next prepared release and its content hash |
| intake-paused.json | Present while the app has paused new work for an update; lapses on its own after 30 minutes |
| intake-paused.ack.json | The bot's acknowledgment of that pause, with the requests it is still starting |
| held-requests.jsonl | Requests that arrived during that pause, started by the bot once it is over |
| active.json | Current activated release |
| activation.json | Latest cutover transaction and rollback information |
| backups/ | Previous plist and settings at cutover; `backups/brief/` keeps the brief and policy replaced by an applied rewrite |
| logs/bot.log | Background-service output |

Profile folders are created with mode 700 and .env with mode 600. Keep profiles out of shared code and include them in your private backups. Never copy a real profile as another engineer's starter.

## Profile format

Start with examples/profile.json. Required fields:

- version is 1.
- bot.id is a stable lowercase identifier, beginning with a letter, at most 48 characters. Letters, digits, and hyphens are allowed. bot.name is the display name.
- owner.name, owner.slackUserId, and owner.githubLogin identify the human responsible for the bot. The owner is always included in the allowlist.
- project.path is an absolute path to a Git checkout registered in T3. project.remote names the fetch remote. project.baseRef is the exact ref used for fresh worktrees. project.githubRepo is owner/repo on github.com.
- allowedUsers is an array of additional Slack member IDs, and may be empty.

Optional fields:

```json
{
  "review": {
    "channel": "C0123456789",
    "repositories": ["acme/main", "acme/service"]
  },
  "repositories": [
    { "name": "Service", "path": "/absolute/path/to/service", "baseRef": "origin/main", "githubRepo": "acme/service" }
  ],
  "worker": { "provider": "claudeAgent", "model": "claude-opus-5-5" },
  "t3Bin": "/absolute/path/to/t3",
  "serviceLabel": "dev.serra.friday",
  "branchPattern": "{id}/{slug}-{stamp}",
  "updates": { "source": "/absolute/path/to/serra", "ref": "origin/main" }
}
```

`updates` turns on developer mode for Updates, for working on Serra itself. `source` is a git checkout of the Serra repository and `ref` the branch to follow in it (`origin/main` by default). Updates then counts the commits on `ref` the running bot lacks, and **Fetch commits** fetches that branch from its remote first; **Build from checkout** copies the checkout as it is (keep it on `ref` and run `git pull` there). Without `updates`, the app updates from GitHub Releases and the bot follows the app's version on its own (see [app updates](app/install.md#updates)). Set it in the app under Settings › Worker › Developer: update from a checkout. It applies at once; the daemon doesn't read it.

`branchPattern` names the task branch each job's worktree starts on. Placeholders: `{id}` the bot ID, `{slug}` from the request, `{stamp}` a short unique suffix, `{DDMM}` and `{MMDD}` today's date. It must contain `{slug}` and `{stamp}` so two jobs never share a branch, and setup rejects patterns that can't make a valid Git branch. The default is `{id}/{slug}-{stamp}`. Example for a team that names branches after a placeholder ticket: `TEAM-{DDMM}/{slug}-{stamp}`. The worker can still rename the branch before its first push.

`worker` chooses which T3 provider instance and model run the bot's jobs. `model` is required and `provider` is optional; T3 needs a model whenever a provider is given. Without `worker`, jobs use the T3 project's default model, which may differ from the one you pick when you work in T3 yourself. The names are the ones `t3 thread start --provider` and `--model` accept: `provider` is T3's instance id, such as `claudeAgent` or `codex` (not `claude`).

Omit review to disable posting to a review channel. Review messages require an open, ready PR in the configured allowlist, authored by the configured GitHub account, with gh currently using that account. The daemon strips channel and group broadcasts from review messages. Worker instructions determine whether a PR should be made ready; the generic default is draft.

Additional repositories are included in the brief and checked by doctor. Workers create separate worktrees before changing them. Add repo-specific instructions to knowledge and owner policy. No secondary repository is assumed for new profiles.

The service label defaults to dev.serra.<bot-id>. Do not change a deployed bot's ID or service label as a way to rename it.

## Tokens and precedence

Each Slack token (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) has a source:

- **Keychain**: a generic password item, read with the macOS `security` CLI. The default item is the bot's service label (`dev.serra.<bot-id>`) as the service and the token name as the account.
- **1Password**: a secret reference like `op://vault/item/field`, read with the 1Password CLI (`op read`). Turn on the 1Password app's CLI integration so `op` can unlock.
- **.env**: the profile's `.env`, the fallback when no source is set.

A token is read from, in order: the process environment, its source in `secrets.json`, then the profile's `.env`. It never comes from a checkout's `.env`. A token with a Keychain or 1Password source doesn't fall back to `.env` when the source fails: the daemon refuses to start and names the source. `security` and `op` run as child processes with a 30-second timeout, and only when a token is used, so `pnpm bot stop` and `pnpm bot status` never open 1Password.

```sh
pnpm bot secrets --profile /absolute/profile                      # each token's source and last check
pbpaste | pnpm bot secrets set SLACK_BOT_TOKEN --keychain --profile /absolute/profile
pnpm bot secrets set SLACK_BOT_TOKEN --keychain --existing --service <service> --account <account> --profile /absolute/profile
pnpm bot secrets set SLACK_APP_TOKEN --1password op://vault/item/field --profile /absolute/profile
pnpm bot secrets set SLACK_APP_TOKEN --env --profile /absolute/profile   # back to .env
pnpm bot secrets check --profile /absolute/profile                # resolve, then ask Slack
```

`--keychain` reads the token on stdin, so it stays out of shell history and the process list, and it is passed to `security` on stdin too. After a check passes, delete the token from `.env`. `check` resolves the token and asks Slack: the bot token with `auth.test`, the app-level token with `apps.connections.open` (which only issues a Socket Mode URL; nothing connects). A passing bot-token check saves the workspace URL in `secrets.json`, for Slack thread links. Messages and `secrets.json` never contain a token value; anything shaped like a Slack token is replaced with `[hidden]`.

profile.json supplies non-secret settings, including the expected owner and repository.

`allowedUsers` and `messageTriggers` apply as soon as profile.json is saved: the daemon watches the file, validates it again and keeps its running settings if the new file is invalid (logged once as `profile_invalid` in `logs/events.jsonl`). Restart after editing any other profile.json section, .env or a token's source. Brief and knowledge are read for new jobs. Existing T3 conversations retain their original brief. Knowledge edits are visible when those workers read their configured pages.

## Automatic alert investigations

Add `messageTriggers` to profile.json to investigate messages from a bot, a person, or anyone in a particular channel without an @mention:

```json
{
  "messageTriggers": [
    {
      "channel": "C0123456789",
      "botId": "B0123456789",
      "instructions": "Investigate this Sentry alert. Check the linked incident and relevant repository code. Reply with impact, supporting evidence, likely cause, and recommended next steps."
    },
    {
      "channel": "C0123456789",
      "userId": "U0123456789",
      "instructions": "Investigate this person's report and reply with evidence and recommended next steps."
    },
    {
      "channel": "C9876543210",
      "instructions": "Investigate each new message in this channel and summarize the findings in its thread."
    }
  ]
}
```

Use the channel ID from its Slack link. Set `botId` to the sender's exact `bot_id` from a Slack message payload, or set `userId` to a person's Slack member ID (`U...` or `W...`). A bot ID starts with `B`; it is different from the bot's member ID (`U...`) and app ID (`A...`). Display names and message text are not used to authenticate the sender. A rule cannot specify both a nonempty `botId` and a nonempty `userId`.

Omit both sender fields, or leave them empty (including whitespace), to match messages from any bot or person in that channel. Each channel/sender pair can appear only once, and each channel can have only one rule for all senders. If a sender matches both a specific rule and the channel-wide rule, the specific rule supplies the instructions, regardless of their order. Omit `messageTriggers`, or set it to an empty array, to disable automatic investigations. Keep workspace-specific rules in your private profile.

The bot adds 👀 to a matching new top-level message, starts a T3 investigation, and posts the findings in that message's thread. The reaction is removed when the answer is posted, following the usual acknowledgment behavior. Text in alert attachments and supported message blocks is included, so thresholds and incident links can reach the investigator even when the top-level text is empty. Alert files and image URLs are not downloaded automatically.

Rules authorize read-only investigation, including when the sender is a person outside `allowedUsers`. The investigator gets the configured instructions separately from the untrusted message content, and is told to report evidence, impact, likely cause, and next steps. An automatically matched message alone does not authorize code changes, PRs, deployments, or changes to shared systems. Allowed people can continue the conversation in the thread; the human allowlist still applies to follow-up requests and explicit @mentions. Do not add bots to `allowedUsers`.

Only matching new top-level channel messages start investigations. Messages in other channels, unmatched senders, edits, hidden messages, and bot replies are ignored. The engineering bot's own messages are always ignored, even with a channel-wide rule. Human messages that @mention the engineering bot use the usual request flow instead of an automatic investigation. Replies continue through the existing owned-thread flow; rules do not start investigations in other threads or in DMs. Concurrent or retried delivery of the same Slack message does not start another investigation once its job is saved. Separate messages each start their own investigation, even if they refer to the same incident.

Invite your engineering bot to the alert channel. The supplied manifest already subscribes to `message.channels` and `message.groups` with the corresponding history scopes, as well as the reaction and message-writing scopes. Existing apps must have those subscriptions and scopes installed. Prepare and activate the updated release using the normal update commands after editing the profile.

This uses the existing Socket Mode connection. Slack sends message events over that connection while the daemon and T3 are running; there is no polling of channel history or replay of old alerts on startup. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) avoids a public HTTP receiver. HTTP Events API delivery is an alternative transport for a hosted service. [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) send messages into Slack and do not subscribe to messages received in a channel.

## Tools: MCP servers and command-line tools

The worker gets MCP servers (Sentry, Datadog and the like) from its T3 provider, not from Serra. You add and remove them in Claude or Codex (`claude mcp add --scope user …`, `codex mcp add …`). Use user scope: T3 runs each job in its own worktree, which gets user-scope servers but not ones added for a single folder.

The app's **Tools** screen and `pnpm bot tools --profile /absolute/profile` are read-only. They show:

- **MCP servers**, for the provider in `worker.provider`, or for every provider turned on in T3 when it isn't set. The provider list comes from T3's own settings (`~/.t3/userdata/settings.json`, or `$T3CODE_HOME`), so Cursor, Antigravity and T3's other providers show up when they're on. Serra can read Claude's and Codex's MCP setup; any other provider is listed as **Not supported yet** rather than guessed. Without T3's settings, Serra lists both Claude and Codex and says why.
  - Listing runs the provider's own command, which does what the provider does when a job starts: `claude mcp list` connects to each server (starting local ones) to check its health, and `codex mcp list` loads Codex's own sign-in. Serra itself writes nothing. The provider CLIs run with your login shell's environment, as T3's jobs do, so a server that reads a token from it checks the same way. Serra reads that environment once and keeps it for five minutes; Check again reads it afresh.
  - Claude's come from `claude mcp list`, run in the project's checkout (or your home folder when the checkout is missing). That covers claude.ai connectors and plugin servers, with Claude's own health check (Connected, Needs sign-in, Failed, Needs approval).
  - Codex's come from `codex mcp list --json`, including servers Codex adds itself.
  - When a CLI is missing or fails, the list falls back to the config files: `~/.claude.json`, the checkout's `.mcp.json`, and `~/.codex/config.toml`. The screen says so.
  - A server is shown by name, origin, transport and host. Its command, arguments, environment, headers and full URL never leave the main process.
  - T3 also gives every job its own `t3-code` server, which isn't in these lists.
- **Command-line tools:** GitHub, Vercel, Atlassian (`acli`), Sentry, Docker, AWS, Google Cloud, Azure and Fly.io.
  - Each shows whether it's installed, its version, and whether it's signed in (or, for Docker, running), where the tool has a cheap read-only check: `gh auth status` (plus `--no-refresh` when the installed gh's help lists it), `acli jira auth status`, `gcloud auth list`, `az account show` and `docker info`. AWS, Vercel and Fly.io aren't checked for sign-in: their checks can run credential helpers or refresh saved credentials. These third-party checks run with a small allowlisted environment (no tokens from Serra or your shell), and with telemetry, update checks and log files turned off where the tool has a switch.
  - Serra looks on your login shell's `PATH`, plus `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. Set `SERRA_TOOLS_PATH` to replace that search path.
  - Serra never installs or signs in to anything. It shows the vendor's install or sign-in command to copy.
- **Recommended** (on the screen only):
  - GitHub always.
  - Sentry when an alert rule mentions it or the repo uses a Sentry SDK.
  - Vercel when the repo has `vercel.json`.
  - Atlassian when your brief, knowledge or alert rules mention Jira, Confluence or `atlassian.net`.
  - Linear when they link to `linear.app`.

  Each shows whether it's ready, and the commands to set it up: the CLI's install, or the provider's `mcp add` for the vendor's MCP server. The list lives in `src/tool-catalog.ts` and changes by pull request; nothing is fetched.

When a message trigger's instructions name Sentry, Datadog, PagerDuty or Grafana and the worker has no server for it, both the Tools screen and `pnpm bot tools` warn.

Not covered yet: a worker on a linked remote T3 machine. Tools reads this Mac's provider CLIs, config files and `PATH`, which can differ from that machine's.

## Brief placeholders

The template supports BOT_NAME, BOT_ID, OWNER_NAME, OWNER_GITHUB, BASE_REF, PROJECT_PATH, REPOSITORIES, REQUESTER, PERMALINK, REQUEST, THREAD_CONTEXT, KNOWLEDGE_DIR, KNOWLEDGE_INDEX, OWNER_PROFILE, VISIBILITY, PROPOSALS_DIR and POLICY_PATH, each enclosed in double braces. Unknown template placeholders fail before a worker is started. Values are replaced in one pass, so placeholders appearing inside Slack messages stay as text. A placeholder written in parentheses after a space, like ` ({{PERMALINK}})`, is left out with its parentheses when it is empty: a task started in the app has no Slack link, so its worker reads "Alex asked:".

## Slack names in the app

The app's Jobs screen, notifications and **Settings › People** show people by their Slack display name (or real name) and channels as `#name`, instead of IDs like `U0EXAMPLE01`. The app never reads the bot token for this, so opening it never asks Keychain or 1Password: it asks the running bot over the profile's status socket, and the bot looks the IDs up with the token it already holds, using `users.info` (scope `users:read`) and `conversations.info` (scopes `channels:read`, `groups:read` and `mpim:read`). Only names come back. The app keeps them in the profile's `slack-names.json` (names only, readable by you alone), so known names show at once, even while the bot is stopped. DMs show as "DM" without a lookup. Names are refreshed after six hours; a name the bot can't find shows the raw ID and is asked for again after ten minutes. While the bot is stopped (or still on a version from before this), new IDs stay raw and the app asks again later. Rows never wait for a lookup: names fill in when they arrive. On People, the owner's name comes from the profile; an allowed person whose name isn't known yet shows "Name not known yet" beside their member ID.

The supplied manifests include these scopes. For an app created from an older manifest, add `channels:read`, `groups:read` and `mpim:read` under OAuth & Permissions and reinstall the app to the workspace.

**The bot needs them too.** Before it posts in a channel, the bot asks Slack who can see it, so a reply written with team-only knowledge never lands in a channel shared with another company. Without these scopes Slack won't say, so the bot posts a short notice instead of its reply in channels, and the app shows a failure naming the missing scope. DMs with you aren't affected.

## Incoming attachments

Human file uploads are accepted in DMs, mentions, and threads the bot already owns, including uploads without accompanying text. The worker receives file metadata and private local paths, with instructions to inspect images and documents and acknowledge file-only messages. Files addressed explicitly to another person stay conversation context. File-only messages from people outside the allowlist do not start work or download files.

The Slack app needs the bot OAuth scope `files:read`. For an existing app, add it under OAuth & Permissions and reinstall the app to the workspace; refresh the selected profile's bot token if Slack issues a new one. Updating source code or a generated manifest alone does not change an installed app's permissions.

Downloads allow up to five files per message and 20 MiB per file, with a 30-second download timeout. When joining an existing thread, only the newest context that fits the context window is considered, with one shared five-file download budget for its history. Extra, inaccessible, externally hosted, oversized, or failed downloads are described to the worker so it can explain the limitation and request another upload. Slack-hosted files are downloaded using the bot token; only HTTPS URLs on `files.slack.com` receive it, including up to three redirects within that trusted host. External hosts and unsafe redirects never receive the token.

Files are cached under the selected profile's `attachments/` directory, outside the repository, with private directory and file permissions. The local worker must have access to that profile path. Files remain there for follow-up turns and are not automatically deleted; remove the directory manually when those conversations no longer need their attachments. Attachments are untrusted data and are never executed by the bot.

## What the daemon does with a reply

- `Needs owner:` at the start of a line pings the owner. `Needs <owner name>:` also works for the configured owner. The ping happens once per ask: a later reply that is still blocked doesn't ping again until the owner has written in the thread.
- A reply on a thread a teammate started cc's the owner once, so they follow it. Later replies don't mention them.
- `(quiet)` as the first line posts nothing and removes the eyes reaction. Workers use it for a background turn with nothing new, and for thread messages that weren't for the bot.
- A run the worker started on its own, such as following CI or fixing bot review findings on its PR, edits one status message ("Updated <time>") instead of posting each update. It posts a new message when the update needs someone: a `Needs` line, a review request, an upload, or the owner's first cc. Any reply to a person ends the status message, so the next update starts a new one below it.
- While a run someone is waiting on has gone on for 3 minutes, one "Still on it" line shows the worker's latest note, edited as the note changes. It is deleted when the reply is posted. Background runs, and turns nobody @mentioned the bot in, show no progress line.
- A failure shows teammates a plain sentence and pings the owner. The error goes to the log, and to the owner in the thread only when the owner made the request.
- `<review-request>` blocks request review posting through the daemon.
- Local images and videos, embedded as `![title](/absolute/path)`, are uploaded only from the approved T3 worktree, generated-image, QA, and temporary folders. Other paths produce an explanation in the reply.
- A plain link to a local `.html`, `.htm`, `.pdf`, `.zip`, `.csv`, `.txt` or `.md` file in a T3 worktree, a QA-run folder or `/tmp` is uploaded to the thread (25 MB each, up to 4 per reply), and the link reads `label (attached above)`. A link that can't be uploaded is left as it is.
- A link to any other local file becomes plain text, since nobody in Slack can open it. A path inside a worktree or a configured repository is shown from the repository root.

## Questions in Slack

Native T3 clarification questions appear in their Slack thread as buttons, a selection menu, or a multi-select menu with a Submit button. Long choice labels appear in full above the controls, with short numbered captions on the controls; the complete original value is sent as the answer. The original requester and bot owner can answer. A typed thread reply also answers the current question; a restricted choice accepts its label or number. Each question in a multi-question form is shown in order in the same message. Once the final answer is sent to T3, the message shows the answers and the worker resumes. Duplicate clicks and retried message events cannot answer the next question. If someone answers in T3, the old Slack controls expire on the next poll.

Enable **Interactivity & Shortcuts → Interactivity** in the Slack app settings. Existing Socket Mode carries the button actions without a public Request URL or extra OAuth scopes. The supplied manifests enable this setting. Questions and partial answers are kept in the profile's job state so a daemon restart preserves them. New job briefs and follow-up messages tell workers that native question forms are supported.

The bridge calls the local T3 server and uses short-lived CLI-issued credentials. It forwards only ordinary user-input questions; credentials and permission approvals must be completed in T3. Forms with more than 20 questions, more than 20 options per question, or content exceeding Slack's display limits stay in T3. If the question interface is unavailable, the existing owner notice links to T3 instead.

## Pings

A new mention or DM that only checks the bot is there ("are you there?", "hi", "just testing") gets an immediate "I'm here. What do you need?" from the daemon, with no worker and no worktree. For 30 minutes the bot follows that thread for the person who pinged: their next message starts the job, with or without an @mention, unless it is addressed to someone else. "ok", "thanks" or another ping start nothing. Other people still need an @mention. A restart forgets this, and an @mention always works.

## Logs and events

`logs/bot.log` lines carry an ISO timestamp, level and logger name. `logs/events.jsonl` has one JSON line per event: `job_started`, `ping_answered`, `reply` (with `kind` = `reply`, `quiet`, `status_posted` or `status_edited`, `byWorker`, `needsOwner`, `runMs` and `jobAgeMs`), `progress_shown`, `waiting_in_t3`, `question_shown`, `question_answered`, `question_fallback` and `failure`. Question events identify the request and answering user without recording answer text. A `question_fallback` event records display-limit sizes when a form must stay in T3, without including its content. For example, time to first reply per job:

```sh
jq -s 'map(select(.event=="reply" and .kind=="reply")) | group_by(.key) | map({key: .[0].key, firstReplyMin: (.[0].jobAgeMs/60000|floor)})' logs/events.jsonl
```

## What the worker gets from the thread

The first message of a job is the brief. After that, the worker gets what people say in the thread, each message quoted under its author's name, with the owner marked. Messages are held for a few seconds of silence and until the worker's current turn ends, then sent together. A message that @mentions other people and doesn't name the bot is included as context, marked as said to someone else, and doesn't start a turn on its own. A text-only message without an @mention of the bot starts a turn with a note that the worker may answer `(quiet)`; an upload from an allowed person asks for acknowledgement even without a mention. Someone outside the allowlist is refused when they mention the bot, and is context when they only chat in the thread.

## Cleaning up worktrees

Every job gets its own T3 worktree, and nothing removes them as they finish. `pnpm bot cleanup --profile <dir>` lists each job's worktree and whether it would be removed; add `--apply` to remove them, and `--days N` (default 3) for how long a job must be quiet first. A worktree is removed only when the job has been quiet in Slack and in T3 for that long, its T3 run is finished, T3 and `gh` report no open PR for its branch or the branch checked out now, `git status` is clean, and neither the branch nor the worktree's HEAD has unpushed commits. Removal uses `git worktree remove` without `--force`; gitignored files in the worktree (local env files, QA output) go with it. Any check that can't be made keeps the worktree. Job state is never changed: a later message in that Slack thread still reaches its T3 thread, whose worktree is gone, so for real follow-up work start a new thread. Cleanup never runs on its own.
