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
- **Not the transcript.** It's read in memory, secrets are redacted before Claude sees it, and it's never written to disk.

Only team meetings for now: until workers are isolated from the profile folder, any worker could read pending quotes.

## Sources

Serra never holds a Granola or Google key. It reads through **your own Claude Code connections**, the same ones your workers use:

| Source | What you need |
|---|---|
| Granola | The Granola connector in Claude (claude.ai › Settings › Connectors), or `claude mcp add granola --transport http https://mcp.granola.ai/mcp`, then sign in with `/mcp`. Transcripts need a Granola Business or Enterprise plan. |
| Google Meet | The Google Drive connector in Claude, signed in. Meet saves transcripts to Drive on Workspace Business Standard and above, when transcription is on. |
| File or paste | Nothing. Every notetaker exports text. |

Settings › Meetings › Sources › **Check** shows whether each works now and what to do if not.

To read a meeting, Serra starts Claude Code (the same tested build, no managed hooks) for one turn with exactly one read tool allowed (Granola's `get_meeting_transcript`, or Drive's `read_file_content`), with exactly Serra's arguments, every built-in tool off, and the meeting's ID as the only input. Claude Code runs the tool and stops before any model sees the result; Serra takes the transcript from it.

## How it's read

The extractor is one Claude Code call with **no tools, no MCP servers and no saved session**, from an empty folder, with the prompt on stdin. Before any transcript is sent, Serra checks:

- the Claude Code version is one it was tested with;
- managed settings define no hooks;
- a probe of the same launch reports zero tools and zero MCP servers;
- a canary self-test passes.

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

It can't reach your upload in Slack, the copy Claude processed, or T3 threads that already read it.
