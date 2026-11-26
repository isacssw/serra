# Meetings

Serra can keep the decisions from your team's meetings, so tickets, briefs and answers know why things are the way they are. It's off until you turn it on in **Settings › Meetings**.

## Adding a meeting

In your DM with Serra, send a **new message** starting with "remember this meeting", with one of:

- a **Granola** note link (`https://notes.granola.ai/d/…`)
- a **Google Meet** transcript Doc link (`https://docs.google.com/document/d/…`)
- a transcript file: `.txt`, `.md`, `.vtt` or `.srt`, up to 200 KB
- the transcript or summary pasted after the phrase

Serra replies in that thread, then posts a digest: the decisions waiting for you in **Knowledge › Proposals**, plus action items and open questions. Action items stay in the digest; Serra doesn't file tickets from meetings yet. The digest's thread is closed, since its action items aren't checked against the transcript: to act on one, send a new message.

Sending a meeting Serra already has (the same transcript, however it arrives) gets a short reply saying so, and nothing is read or proposed again. Serra compares a fingerprint of the transcript's turns, ignoring spacing and case. After **Forget**, you can send it again.

Only your own messages count, and only as a new message in your DM. With capture off, a message of yours anywhere that starts with "remember this meeting" is turned away (its thread closed), so a transcript never reaches a worker by accident.

## What Serra keeps

- Decisions and undated constraints, at most 8 per meeting, as one bullet each under `## Decisions` on a page your team may read, or on one new page under `decisions/`. Never `owner/` or `people/`.
- A decision that changes a rule already on the page ("Releases go out on Wednesdays" against "Releases go out on Tuesdays") is proposed as a **replace**, wherever that rule sits on the page. Approving it takes the old line out (the review shows it removed), puts the new bullet under `## Decisions`, and keeps the old line under `## Replaced` with the date it stopped applying.
- Each bullet only after you approve it, with the quote and the turns around it in front of you.
- Pending quotes for review, up to 30 days, in the profile folder (not `knowledge/`).
- A fingerprint of each meeting's transcript (a SHA-256 hash, not the text) in the profile folder, to catch the same meeting sent twice. Forget removes it.
- **Not the transcript.** Serra reads it in memory, redacts secrets before any model sees it, and never writes it to disk, Slack, a pull request or knowledge. T3 keeps the runs that read it in its own history, like any thread (see below).

Only team meetings for now: until workers are isolated from the profile folder, any worker could read pending quotes.

## Sources

Serra never holds a Granola or Google key. It reads through **the connections of the AI provider you use in T3**, the same ones your workers use:

| Source | What you need |
|---|---|
| Granola | A Granola connection in that provider, signed in. For Claude: claude.ai › Settings › Connectors › Granola. For others, add Granola's MCP server (`https://mcp.granola.ai/mcp`). Transcripts need a Granola Business or Enterprise plan. |
| Google Meet | A Google Drive connection in that provider, signed in. Meet saves transcripts to Drive on Workspace Business Standard and above, when transcription is on. |
| File or paste | Nothing. Every notetaker exports text. |

Settings › Meetings › Sources shows which T3 provider and model meeting runs use (the profile's worker, else T3's default) and whether T3 has it turned on. That reads files only. **Test** on a source starts one short T3 run that asks the provider whether it has that connection: it's the only time the screen makes a model call, and only when you press it. The run may look its tools up but calls none of them, and if it says the connection is missing, Serra asks once more in the same thread, since a connection added after T3 started can take a moment to appear. Serra keeps the answer in `meeting-sources.json` in the profile, so the row still says what the test found (and when) after you leave the screen or restart the app; the button becomes **Test again**. An answer counts for a week, and only on the provider and model it ran on: change either and the source shows untested again.

## How it's read

By default meeting runs go through T3, and Serra never starts Claude Code, Codex or any other provider itself. Reading a link and picking out decisions are each **one T3 thread**, on the provider and model you picked, so it works with any provider T3 has (Claude, Codex, Cursor, Antigravity and the others).

**Or an ACP agent.** Settings › Worker › **Agent backend** can run meeting runs (and everything else, see [agent-backends.md](agent-backends.md)) on an agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) instead: Claude Code, Codex, OpenCode (`opencode acp`) or Gemini CLI (`gemini --acp`). Serra ships the ACP adapters for Claude Code and Codex and runs them itself, on your own `claude` or `codex` command and its login (as T3 does), so you only need that CLI installed and signed in. OpenCode and Gemini CLI can be picked when their command is on your PATH. Serra installs nothing. The agent uses its own login, and the model you pick for it (else its own default). With an ACP agent:

- Serra starts the agent on this Mac over stdio (no server), and stops it when the run ends.
- Every run is moved to a mode where the agent asks before using a tool (Codex's read-only mode, or Claude Code's Manual mode instead of your `auto`). Extraction, Test and the weekly review refuse every request, and Serra then stops the run, as in T3's approval-required mode; a run that can't be put in such a mode doesn't start. A link run may use a read, search or fetch tool once per request; edits, deletes, moves, commands and mode switches are refused.
- A meeting run lives in Serra's process: if Serra restarts, a run in progress ends (resend the meeting). There's no thread to open and nothing kept in T3's history.

- **Where:** every run starts in Serra's own empty folder, `~/.local/share/serra-meeting-runs`, which Serra adds to T3 as a project of its own ("Serra meetings"). Never your repository, a worktree or the profile folder.
- **How Serra talks to T3:** through the `t3` command, and through T3's own tool endpoint on this Mac for the two things the command can't do: read a run's tool results, and stop a run. For that, Serra asks `t3` for a session that lasts 30 minutes at most and revokes it when the run is done. It's listed in `t3 auth session list` as "Serra meetings" while it's open.
- **Extraction and Test run in T3's "approval-required" mode.** They need no tools (Test may only look its tools up), so any tool the provider tries that needs approval stops, and Serra stops the run. Serra can stop these runs itself.
- **A link run runs in T3's default mode**, because it has to call the source's read tool without asking. It's an ordinary thread with the same access as any other. T3 can't take tools away from it, so nothing enforces read-only. That's why capture is off until you turn it on.
- **Read-only brief:** no files, no commands, no web, no changes anywhere, no questions; the transcript is untrusted text. A link run may make one call of one read tool of the source's connection (Granola's transcript tool, or Drive's file reader) for the meeting's ID. The extraction run is told to use no tools at all. The brief asks; it doesn't enforce.
- **A link's transcript is the tool's own result.** Serra reads what the tool returned from T3's record of the run, whole, so quotes are checked against the real transcript, never the model's copy. This works the same for every provider. If T3 has no record of that tool call, or the result was cut short (a provider or T3 marks a result it shortened, and Serra must be able to read the record whole), or the tool returned an error, Serra refuses it: you get "too long" (export the transcript and send the file) or a plain error. It never falls back to the model's copy.
- **Checked after:** the folder must be empty before a run and still empty after it, or the answer is thrown away. Files left there are moved, never deleted, to `~/.local/share/serra-meeting-runs-leftovers/<time>/`, so the next run can start. Check them and delete them yourself.
- **Runs Serra gives up on are stopped.** A run that stops for an approval or a question, or takes over 10 minutes, isn't waited on. Serra stops it in T3. T3 doesn't let Serra stop a link run (it runs in T3's default mode), so then the reply gives you its link to stop it in T3.
- **Errors:** a run's error is turned into a fixed sentence; Serra never repeats what the run wrote. A failed `t3` command gets a short reason in your DM (for example "T3 Code isn't running"); its output stays in the bot's log.
- **No secrets in briefs:** a brief holds Serra's rules, the meeting's ID, the pages a decision may go on, and the transcript after secret redaction. Thread titles never hold meeting text.
- **What stays:** T3 keeps those threads in its history on this Mac, and the provider processes the text under its own terms. Delete the threads in T3 (project "Serra meetings") if you want them gone.

Serra's checks narrow what reaches you:
- each quote must be in the transcript;
- links must appear in it;
- lines addressed to Serra are never evidence;
- sensitive topics are dropped;
- targets must be team pages.

They can't prove a decision is right or final. **Your review is the real check.**

## Forget meeting

Settings › Meetings › **Forget** removes everything a meeting added:
- its page lines, from pages, the approved copy and every backup (a rule it replaced is current again, under `## Decisions`);
- the folders workers read (threads that read it start fresh on their next message);
- a `decisions/` page it created, once nothing else is on it (also one an earlier forgotten meeting created);
- its pending quotes and transcript fingerprint;
- its digest message.

It can't reach your upload in Slack, the T3 runs that read the meeting (delete them in T3's "Serra meetings" project), the provider's copy, or T3 threads that already read it.
