# Telegram

Message your bot from your phone. Serra serves Telegram beside Slack: the same jobs, knowledge and agent, answered in
the chat you asked in. It reaches Telegram by long polling, so nothing listens on your Mac and no server is needed.

## Connect

Picked **Telegram** on setup's first screen? Setup walks you through the same steps, and the bot runs on Telegram alone
(no Slack needed). To add Telegram to a bot that already runs, use **Settings › Channels**:

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a username. It answers
   with a token like `123456:ABC…`.
2. In Serra, **Settings › Channels** › Telegram › **Connect**, and paste the token. Serra checks it with Telegram and
   keeps it in the Keychain. A 1Password reference (`op://vault/item/field`) works too, and on Linux it's the way.
3. **Open in Telegram**, and tap **Start**. The link carries a one-time code (good for a day), so the first person to
   open it is you: Telegram can't tell Serra who made a bot. From then on the bot is yours there.

Connecting restarts the bot when it's running. Right after Serra updates, the bot may still run the older version
for a while (it updates once no job is running): Connect then asks you to update the bot first, in **Settings ›
Updates**. **Disconnect** forgets the bot and its owner; the Keychain item stays
until you connect again.

## Using it

- **Private chat:** write to the bot. A message continues the job you were in for half an hour; after that, or when it
  starts with `/new`, it starts a new job. Reply to any of the bot's messages to go back to that job.
- **Groups:** add the bot and mention it (`@yourbot …`) to start a job; reply to its messages to follow up. A group
  counts as outside your team, so its jobs only get knowledge you share with everyone.
- 👀 means the bot has your message; 😴 means it waits for an update to finish.
- Questions with a few answers come as buttons; tool approvals are yours alone. Photos and files reach the agent (up
  to 20 MB); files the agent names come back in the chat.
- **Approvals follow you:** when an agent working on your own request asks to run a tool, the approval also comes to
  your private chat with the bot here, even for a job in another chat, with a line saying where it's from. Tap an
  answer here or there: the first one counts, and every copy then says it's done ("Answered in Slack"). Slack gets a
  copy in your DM with the bot once you've written to it there. Teammates' approvals and other questions stay in their
  thread.

## Limits (alpha)

- Owner only: on Telegram, the bot takes requests from you, not from the people allowed in Slack.
- Telegram keeps no history a bot can read: Serra keeps its own short record of each thread (`telegram/threads.json`
  in the profile), so a thread's earlier messages reach the agent.
- A long reply is cut at Telegram's 4,096 characters; the full one is in T3 and Jobs.
