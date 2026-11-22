# Meetings

Serra can keep the decisions from your team's meetings, so tickets, briefs and answers know why things are the way they are. It's off until you turn it on in **Settings › Meetings**.

## Adding a meeting

In your DM with Serra, send a **new message** starting with "remember this meeting", with one of:

- a **Granola** note link (`https://notes.granola.ai/d/…`)
- a **Google Meet** transcript Doc link (`https://docs.google.com/document/d/…`)
- a transcript file: `.txt`, `.md`, `.vtt` or `.srt`, up to 200 KB
- the transcript or summary pasted after the phrase

Serra replies in that thread, then posts a digest: the decisions waiting for you in **Knowledge › Proposals**, plus action items and open questions. Action items stay in the digest; Serra doesn't file tickets from meetings yet. The digest's thread is closed, since its action items aren't checked against the transcript: to act on one, send a new message.

Only your own messages count, and only as a new message in your DM. With capture off, a message of yours anywhere that starts with "remember this meeting" is turned away (its thread closed), so a transcript never reaches a worker by accident.

## What Serra keeps

- Decisions and undated constraints, at most 8 per meeting, as one bullet each under `## Decisions` on a page your team may read, or on one new page under `decisions/`. Never `owner/` or `people/`.
- Each bullet only after you approve it, with the quote and the turns around it in front of you.
- Pending quotes for review, up to 30 days, in the profile folder (not `knowledge/`).
- **Not the transcript.** Serra reads it in memory, redacts secrets before any model sees it, and never writes it to disk, Slack, a pull request or knowledge. T3 keeps the runs that read it in its own history, like any thread (see below).

Only team meetings for now: until workers are isolated from the profile folder, any worker could read pending quotes.

## Sources

Serra never holds a Granola or Google key. It reads through **the connections of the AI provider you use in T3**, the same ones your workers use:

| Source | What you need |
|---|---|
| Granola | A Granola connection in that provider, signed in. For Claude: claude.ai › Settings › Connectors › Granola. For others, add Granola's MCP server (`https://mcp.granola.ai/mcp`). Transcripts need a Granola Business or Enterprise plan. |
| Google Meet | A Google Drive connection in that provider, signed in. Meet saves transcripts to Drive on Workspace Business Standard and above, when transcription is on. |
| File or paste | Nothing. Every notetaker exports text. |

Settings › Meetings › Sources shows which T3 provider and model meeting runs use (the profile's worker, else T3's default) and whether T3 has it turned on. That reads files only. **Test** on a source starts one short T3 run that asks the provider whether it has that connection: it's the only time the screen makes a model call, and only when you press it.

## How it's read

T3 is Serra's only agent layer: Serra never starts Claude Code, Codex or any other provider itself. Reading a link and picking out decisions are each **one T3 thread**, on the provider and model you picked, so it works with any provider T3 has (Claude, Codex, Cursor, Antigravity and the others).

- **Where:** every run starts in Serra's own empty folder, `~/.local/share/serra-meeting-runs`, which Serra adds to T3 as a project of its own ("Serra meetings"). Never your repository, a worktree or the profile folder.
- **Not sandboxed:** these are ordinary T3 threads on your T3 provider, with the same access as any thread. T3 can't take tools away from a run, so nothing enforces read-only. That's why capture is off until you turn it on.
- **Read-only brief:** no files, no commands, no web, no changes anywhere, no questions; the transcript is untrusted text. A link run may make one call of one read tool of the source's connection (Granola's transcript tool, or Drive's file reader) for the meeting's ID, and must give the transcript back unchanged. The extraction run is told to use no tools at all. The brief asks; it doesn't enforce.
- **Checked after:** the folder must be empty before a run and still empty after it, or the answer is thrown away. A run that stops for an approval or a question isn't waited on. A run's error is turned into a fixed sentence; Serra never repeats what the run wrote. A failed `t3` command gets a short reason in your DM (for example "T3 Code isn't running"); its output stays in the bot's log.
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
- its page lines, from pages, the approved copy and every backup (a rule it replaced is current again);
- the folders workers read (threads that read it start fresh on their next message);
- a `decisions/` page it created, once nothing else is on it (also one an earlier forgotten meeting created);
- its pending quotes;
- its digest message.

It can't reach your upload in Slack, the T3 runs that read the meeting (delete them in T3's "Serra meetings" project), the provider's copy, or T3 threads that already read it.
