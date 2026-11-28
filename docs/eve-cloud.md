# eve on Vercel

A profile's agent can be an [eve](https://eve.dev) agent deployed on Vercel instead of one on this Mac. Jobs, follow-ups,
approvals and questions work as with any ACP agent: approvals and questions wait for you in Slack (or Jobs › Chat),
and nothing runs a tool before you allow it. The profile looks like any other, with a small cloud mark beside its name.

## What you need

| | |
|---|---|
| **Agent URL** | The deployment's address, like `https://researcher.vercel.app`. `https` only (plain `http` only for `127.0.0.1` or `localhost`). |
| **Vercel CLI, signed in** | `vercel login` on this Mac. eve uses your login to reach the deployment and refreshes its own short-lived tokens. Serra never reads or stores them. |
| **Vercel team** (optional) | The team's short name, like `acme`, when your login is in several teams. |
| **Deployment Protection** | Either allow this Mac in the project's **Trusted Sources**, or create a **Protection Bypass for Automation** secret and paste it in **Bypass secret** (or an `op://` 1Password reference). Skip it when the deployment isn't protected. |
| **Node** | Serra runs eve's bridge with `npx --yes eve@1.5.0`, pinned. The first start downloads it. |
| **Model access** | If the agent uses a real model, AI Gateway (or another provider) is set up on the Vercel project. Serra holds no model key for it. |

## Connect

- **New profile:** **Add…** › **Profile**, pick **eve**, enter the URL (team and bypass secret under **More**), then
  **Continue with researcher.vercel.app**.
- **An existing profile:** **Settings › Worker** › **Connect eve agent**, then **Connect researcher.vercel.app**.

The line above the button says what leaves this Mac. Pressing the button is your yes for that host: Serra then checks
the connection (it starts eve and opens a session, with no prompt, so no model call) and saves only if it connects.
Changing to another host asks again. Serra refuses to start eve for a host you haven't said yes to, whatever the
profile's files say.

## What leaves this Mac

- Sent to the deployment: each request (the job's brief), its follow-ups, and your answers to the agent's questions
  and approvals.
- Sent with every request: the profile's knowledge index. Knowledge pages and files on this Mac are not: the agent
  gets no file system or terminal here, no worktree is made for it, and its session gets a neutral folder name.
- Stays here: your files, Slack (and Telegram, Discord) tokens, meeting transcripts (meeting runs use T3 on this Mac
  for a profile on eve), and your Vercel login.

## Secrets

The bypass secret is kept in your login Keychain (service `dev.serra.<bot-id>`, account `eve-bypass`), or stays a
1Password reference. `agent-backend.json` records only where it is. Serra reads it right before each start and gives it
only to eve's own process, in its environment, never on its command line. A new value is used from the next job.
A `VERCEL_AUTOMATION_BYPASS_SECRET` or `EVE_*` setting exported by your shell for another project is not passed on.

## When something's wrong

**Check** (Settings › Worker, beside the host) says one line:

| Line | What to do |
|---|---|
| `Connected · eve 1.5.0` | Nothing. |
| `Sign in to Vercel: run vercel login, then Check.` | Your Vercel login is missing or expired. |
| `This deployment is protected. Add a bypass secret or allow this Mac in Vercel.` | Set Trusted Sources or a bypass secret. |
| `Can’t reach researcher.vercel.app.` | This Mac is offline, or the URL is wrong. |

A job that fails for one of these reasons shows the same line in Jobs. eve's own error text is never shown or logged.

## Stop or revoke

- **In Serra:** **Remove** beside the host in Settings › Worker. New jobs go back to T3 and the Keychain item is
  deleted. Removing the profile deletes it too. A 1Password reference is yours and stays.
- **At Vercel:** `vercel logout` (or revoke the session in your Vercel account), and rotate or delete the bypass secret
  in the project's Deployment Protection settings, or remove this Mac from Trusted Sources.
- What was already sent stays under that Vercel project's logs and retention. Serra can't recall it.

## Limits

The same as eve by URL over ACP: no images, a restart ends a running turn (eve can't reopen a session), no model or
mode choice, and `ask_question` with options is refused by eve itself. Profiles on a paired server can't use eve yet, and a
profile on eve can't move to a server until you remove eve.
