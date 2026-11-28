# Discord

Talk to your bot from Discord: mention it in a server, or DM it. Serra serves Discord beside Slack and Telegram: the
same jobs, knowledge and agent, answered where you asked. It reaches Discord over the Gateway, an outbound connection
like Slack's Socket Mode, so nothing listens on your Mac and no server is needed.

## Connect

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Under **Bot**: click **Reset Token** and copy the token, turn on **Message Content Intent**, and turn off
   **Public Bot** (so only you can add it to a server).
3. In Serra, **Settings › Channels** › Discord › **Connect**, and paste the token. Serra checks it with Discord and keeps
   it in the Keychain. A 1Password reference (`op://vault/item/field`) works too, and on Linux it's the way. If Message
   Content is off, Serra says so before connecting.
4. **Add to server** opens Discord's invite page for your bot: pick your server. It asks only for what Serra needs (view
   channels, send messages and send them in threads, start threads, attach files, read history, add reactions), never
   Administrator.
5. DM your bot the code Settings › Channels shows (good for a day). That makes you its owner: anyone could paste a bot
   token, so Serra doesn't take the owner from Discord.

Connecting restarts the bot when it's running. **Disconnect** forgets the bot and its owner; the Keychain item stays
until you connect again. To revoke the token itself, **Reset Token** in the portal.

## Using it

- **DM:** write to the bot. A message continues the job you were in for half an hour; after that, or when it starts with
  `new`, it starts a new job. Reply to any of the bot's messages to go back to that job.
- **Server:** mention the bot (`@yourbot …`) in a channel. Serra starts a thread from your message and works there;
  reply in the thread to follow up, no mention needed. Mention it inside an existing thread to work in that thread.
- A server counts as outside your team, so its jobs only get knowledge you share with everyone. Your DM with the bot is
  yours alone.
- 👀 means the bot has your message; ⏳ means it waits for an update to finish.
- Questions with a few answers come as buttons; tool approvals are yours alone. Files you attach reach the agent (up to
  20 MB); files the agent names come back in the chat. Nothing the bot posts pings anyone.

## Limits (alpha)

- Owner only: on Discord, the bot takes requests from you, not from the people allowed in Slack. Anyone else gets a
  short refusal.
- No slash commands: mentions, DMs and threads cover it.
- A long reply is cut at Discord's 2,000 characters; the full one is in T3 and Jobs.
- If Discord refuses the token, or Message Content is turned off later, Discord stays down until you fix it and the bot
  restarts (Discord blocks tokens that keep retrying). The log says which. Slack and Telegram keep working.
