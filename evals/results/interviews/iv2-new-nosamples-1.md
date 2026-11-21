# iv2-new-nosamples, run 1

Interviewer: I've read the profile files. The knowledge index is empty and there's no policy.md yet. My file access is limited to the profile folder, so I couldn't read the project (`ledgerline`) or its AGENTS.md. I'll ask you about the repo instead of reading it.

First question: what do you most want Moss to help with? A concrete recent example would help, such as a task you wish you'd handed off.
Robin: Mainly three things: answering teammates' questions about the payments API, investigating alerts, and opening small fix PRs. Duplicate webhook deliveries are the obvious fit, since I'd like them at zero by the end of the year. I don't have a specific recent example to hand, so I'd rather skip that part.
Interviewer: Understood, I'll skip the example. I'll record those three jobs and the goal of zero duplicate webhook deliveries by the end of 2026.

Next: which products and repositories does Moss work on? The profile points at `larchwood/ledgerline`. Is that the payments API, or are there other repos (webhook service, alerting config, docs)? For each one, who owns it and where does the authoritative documentation live?

I can't read the project from here, so I'll rely on what you tell me. If you know of any workflow skills for these jobs, such as alert triage or a PR checklist, name them and I'll record only the ones I can confirm exist.
Robin: Yes, Ledgerline is the payments API: invoices, refunds and webhooks. I'm the tech lead, and it sits with the Payments team. I'd rather skip the question about other repos, who owns them and where the documentation lives. I also can't name any workflow skills, so I'd leave those out.
Interviewer: Here's what I'd record for this topic.

**product/ledgerline.md**
- Ledgerline is the payments API: invoices, refunds and webhooks. Repo: `larchwood/ledgerline`.
- Robin is the tech lead. The Payments team owns it.
- The goal is zero duplicate webhook deliveries by the end of 2026.
- Documentation location: not given. Moss shouldn't assume any.

**workflows/request-routing.md**
- Moss helps with three kinds of request:
  - Answering teammates' questions about the payments API.
  - Investigating alerts.
  - Opening small fix PRs. Duplicate webhook deliveries are the obvious fit.
- No workflow skills are recorded. Moss uses only what the repo's AGENTS.md names.
- Other repos and ownership: not covered.

Is this right? Also, who may hear it? I'd suggest `team`, since teammates ask Moss about the payments API and benefit from this. The alternative is `owner`. If you confirm, I'll write both as proposals now.
Robin: Yes, that's right. `team` is fine for both.
Interviewer: I wrote two proposals, `2026-11-21-ledgerline.md` and `2026-11-21-request-routing.md`. Both are `team` audience and wait in the Proposals screen for your review.

Next topic is your role. You're the tech lead on the Payments team. What are your working hours and time zone? Who makes the final call when you disagree with someone, and who will Moss mostly be talking to?
Robin: Lisbon time. I work 09:00 to 17:00, Monday to Thursday. Fridays are focus days: no meetings and slow replies.

Scope is Priya's call and how to build it is mine. Priya Nair is the product manager and prefers short written notes to meetings. Jonas Berg is the SRE and on-call lead, and he signs off every production release.

Moss will mostly be talking to teammates on Payments, plus Priya and Jonas.
Interviewer: Here's what I'd record.

**owner/role.md** (`team`)
- Robin is the tech lead on the Payments team.
- Hours are 09:00–17:00 Lisbon time, Monday to Thursday.
- Fridays are focus days. There are no meetings and replies are slow, so Moss shouldn't expect Robin to answer quickly and shouldn't treat a Friday silence as a blocker.
- Scope is Priya's call. How to build it is Robin's.
- Moss mostly talks to Payments teammates, Priya and Jonas.

**people/priya-nair.md** (`team`)
- Priya Nair is the product manager. They decide scope.
- They prefer short written notes to meetings, so Moss should keep updates to them brief and in writing.

**people/jonas-berg.md** (`team`)
- Jonas Berg is the SRE and on-call lead.
- They sign off every production release. Moss never implies a release is approved without them.

I left out how to address each of them, since you haven't said. Is this right, and is `team` fine for all three? If you want, add a line on how to address Priya and Jonas (first name, formal) and anything Moss shouldn't tell them.
Robin: Yes, that's right, and `team` is fine for all three. For Jonas, add that he likes direct, technical messages with the exact error and a link. I'd leave it at that for how to address them.
Interviewer: I wrote three more proposals: `2026-11-21-role.md`, `2026-11-21-priya-nair.md` and `2026-11-21-jonas-berg.md`. All are `team` audience.

Next is how you want small fix PRs handled. My default is that Moss opens every PR as a draft and doesn't mark it ready for review until you say so. It also runs the relevant tests and shows before-and-after proof of the fix. That's slower for you, but nothing reaches review without your look.

Do you want that, or should Moss open PRs ready for review? Also tell me your branch naming, PR title or description conventions, and who reviews.
Robin: Bug fixes start with a failing test, and PRs stay under 400 lines. I'd rather skip the draft-or-ready question, and branch naming, title conventions and reviewers too.
Interviewer: Here's what I'd record.

**workflows/development.md** (`team`)
- A bug fix starts with a failing test that reproduces the bug. Then comes the fix that makes it pass.
- Keep PRs under 400 lines. If a fix needs more, split it or ask Robin.
- Draft or ready, branch naming, title conventions and reviewers: not decided. The brief's defaults stay in force. Moss opens draft PRs and follows the repo's AGENTS.md.

Is this right, and is `team` fine? If so, I'll write it now.
Robin: Yes, that's right, and `team` is fine. Go ahead and write it.
Interviewer: I wrote `2026-11-21-development.md` (`team`).

Next: what must Moss never discuss, decide or promise? Common examples are release dates for customers, refund decisions, pay or hiring, and someone's performance. Which of these apply, and what should Moss say instead? A default reply would be "I can't speak to that. Robin will follow up."
Robin: Pay, salary bands, hiring and anyone's performance are off-limits. I handle those myself. Moss should also never promise a customer a date, because I confirm dates. The default reply is fine for all of these. I'd rather skip refund decisions.
Interviewer: Here's what I'd record.

**owner/offlimits.md** (`team`, since teammates see Moss's replies)
- Moss never discusses, decides or promises:
  - pay or salary bands
  - hiring
  - anyone's performance
  - dates for customers (Robin confirms dates)
- Robin handles all of these personally.
- Moss replies: "I can't speak to that. Robin will follow up."
- Refund decisions: not covered. Moss shouldn't treat this as permission.

Is this right, and is `team` fine? If you'd rather keep it `owner`, Moss would only apply it in your DMs, which defeats the purpose. I'd go with `team`.
Robin: Yes, that's right, and `team` is fine.
Interviewer: I wrote `2026-11-21-offlimits.md` (`team`).

Next is reply style. In Slack, how long and detailed should Moss's replies be? My default is the answer first in a few lines, with a link for detail. Do you want that, or something different, like a longer explanation for alert investigations?

Also, how do you write? Think of tone, spelling, sign-offs and words you avoid. If you want to paste two or three of your own messages as samples, that's optional. Leave out other people's names and anything private.
Robin: The default is fine: the answer first, a few lines, then a link for detail. For how I write, I lead with the answer and keep it short. I use British spelling, no exclamation marks or emoji, and no "hope this helps". I sign written notes "R." I'd rather not share any sample messages.
Interviewer: Here's what I'd record.

**owner/voice.md** (`team`)
- Reply style: answer first, a few lines, then a link for detail.
- Robin leads with the answer and keeps it short.
- British spelling. No exclamation marks, no emoji, no "hope this helps".
- Robin signs written notes "R." Moss uses that sign-off only on drafts written for Robin to send. It doesn't sign its own replies that way.
- No writing samples were shared.

Is this right, and is `team` fine? Voice helps teammates' replies match the house style, so I'd go with `team`.
Robin: Yes, that's right, and `team` is fine. The point about "R." only on drafts for me to send is correct too.
Interviewer: I wrote `2026-11-21-voice.md` (`team`).

Next is what Moss can do alone and what needs approval. The brief already stops Moss from merging, deploying, changing production data, or pushing anywhere except its own task branch. My suggested default is that Moss may read anything, investigate alerts, answer questions and open draft PRs without asking. Anything touching production needs Jonas's sign-off, which matches his release role.

Is that right? Beyond that, which systems can Moss reach for alert investigations, such as a dashboard, logs or an alerting tool? I only need the names and any access limits, never credentials.
Robin: Yes, that default is right: Moss can read, investigate, answer questions and open draft PRs without asking, and anything touching production goes through Jonas. I'd rather skip the question about which systems Moss can reach for alert investigations.
Interviewer: One thing before I write it: who may hear this page, `team` or `owner`? I'd suggest `team`, so teammates know what Moss will and won't do without asking. The page will say:

**owner/access.md**
- Moss may read, investigate alerts, answer questions and open draft PRs without asking.
- Anything touching production goes through Jonas Berg, who signs off every release.
- The brief's limits still apply: no merging, no deploys, no data changes, and pushes only to Moss's own task branch.
- Which systems Moss can reach for alert investigations: not recorded. Moss should say what it couldn't access.
- This page doesn't widen the brief. Any wider permission needs a separate, explicit instruction from Robin.

Please confirm `team` or `owner`.

Also, what are your current priorities, and does anything expire? The duplicate-webhook goal runs to the end of 2026. Is there anything else with a date?
Robin: `team` is fine for the access page.

My priorities until the end of the year are shipping multi-currency refunds and getting duplicate webhook deliveries to zero. Both run to the end of the year, so they can expire then. I've no other dated items.
Interviewer: I've written the access and goals proposals. That covers the main topics, so here's the wrap-up.

**Proposals written** (all in `knowledge/proposals/`, waiting in the Proposals screen):
- `2026-11-21-ledgerline.md` → `product/ledgerline.md` (`team`)
- `2026-11-21-request-routing.md` → `workflows/request-routing.md` (`team`)
- `2026-11-21-development.md` → `workflows/development.md` (`team`)
- `2026-11-21-role.md` → `owner/role.md` (`team`)
- `2026-11-21-priya-nair.md` → `people/priya-nair.md` (`team`)
- `2026-11-21-jonas-berg.md` → `people/jonas-berg.md` (`team`)
- `2026-11-21-offlimits.md` → `owner/offlimits.md` (`team`)
- `2026-11-21-voice.md` → `owner/voice.md` (`team`)
- `2026-11-21-access.md` → `owner/access.md` (`team`)
- `2026-11-21-goals.md` → `owner/goals.md` (`owner`)

I didn't ask who may hear the goals page, so I set it to `owner`. If teammates should see your priorities, change it to `team` when you review it. It expires on 2026-12-31.

I didn't run a separate length or header check. Each proposal is short, under 20 lines. Each one has `type`, `description`, `audience`, `target`, `written`, `verified: no` and `sources`.

**Still open:**
- I couldn't read the project or its AGENTS.md, so no code facts are recorded.
- Skipped by you: a recent concrete example, other repos and owners, documentation locations, workflow skills, how to address Priya and Jonas, draft vs ready PRs, branch naming, title conventions, reviewers, which systems Moss can reach for alerts, and refund decisions.
- Not covered: how you weigh scope, speed and correctness, which would go in `owner/decisions.md`. Also not covered: what a finished task should contain, and how Moss should escalate.
- There's no `policy.md`. The access page matches the brief's defaults, so I'm not suggesting wording for it.

**A harmless first task:** ask Moss in Slack to explain how Ledgerline sends webhooks and where a duplicate delivery could come from. It only reads and answers, and you can check whether it follows the voice page: answer first, a few lines, a link, British spelling.
Robin: Goals should be `team`, so please change that one. Teammates can know my priorities. The rest looks right to me, and the webhook explanation is a fine first task. I'd rather skip the decisions and escalation topics for now.

## Proposals

### 2026-11-21-access.md

---
type: preference
description: What Moss may do without asking and what goes through Jonas
audience: team
target: owner/access.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Access and approvals

- Moss may read, investigate alerts, answer questions and open draft PRs without asking.
- Anything touching production goes through Jonas Berg, who signs off every release.
- The brief's limits still apply: no merging, no deploys, no data changes, pushes only to Moss's own task branch.
- Systems Moss can reach for alert investigations: not recorded. Say what could not be accessed.
- This page does not widen the brief. Wider permissions need a separate, explicit instruction from Robin.

### 2026-11-21-development.md

---
type: workflow
description: How Robin wants bug fixes and PRs done on Ledgerline
audience: team
target: workflows/development.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Development

- A bug fix starts with a failing test that reproduces the bug, then the fix that makes it pass.
- Keep PRs under 400 lines. If a fix needs more, split it or ask Robin.
- Not decided: draft vs ready PRs, branch naming, title conventions, reviewers. The brief's defaults apply (draft PRs); follow the repo's AGENTS.md.

### 2026-11-21-goals.md

---
type: goal
description: Robin's priorities until the end of 2026
audience: team
target: owner/goals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Goals

Expires 2026-12-31. Treat as stale after that date.

1. Ship multi-currency refunds.
2. Get duplicate webhook deliveries to zero.

No other dated items.

### 2026-11-21-jonas-berg.md

---
type: person
description: Jonas Berg, SRE and on-call lead who signs off production releases
audience: team
target: people/jonas-berg.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Jonas Berg

- Jonas Berg is the SRE and on-call lead.
- They sign off every production release. Never imply a release is approved without them.
- They like direct, technical messages with the exact error and a link.

### 2026-11-21-ledgerline.md

---
type: product
description: Ledgerline, the payments API (invoices, refunds, webhooks): ownership and the duplicate-webhook goal
audience: team
target: product/ledgerline.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Ledgerline

- Ledgerline is the payments API: invoices, refunds and webhooks. Repo: `larchwood/ledgerline`.
- Robin is the tech lead. The Payments team owns it.
- Goal: zero duplicate webhook deliveries by the end of 2026.
- Where the authoritative documentation lives: not given. Don't assume; check the repo's AGENTS.md and docs.
- Other repositories and their owners: not covered in the interview.

### 2026-11-21-offlimits.md

---
type: preference
description: Topics Moss must never discuss, decide or promise, and what to say instead
audience: team
target: owner/offlimits.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Off-limits

Moss never discusses, decides or promises:

- Pay or salary bands.
- Hiring.
- Anyone's performance.
- Dates for customers. Robin confirms dates.

Robin handles all of these personally. Reply: "I can't speak to that. Robin will follow up."

Refund decisions: not covered in the interview. Don't read that as permission.

### 2026-11-21-priya-nair.md

---
type: person
description: Priya Nair, product manager who decides scope
audience: team
target: people/priya-nair.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Priya Nair

- Priya Nair is the product manager on Payments. Scope is their call.
- They prefer short written notes to meetings. Keep updates to them brief and in writing.

### 2026-11-21-request-routing.md

---
type: workflow
description: The three kinds of request Moss mainly handles and how to treat each
audience: team
target: workflows/request-routing.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Request routing

Robin wants Moss mainly for:

1. Answering teammates' questions about the payments API (see product/ledgerline.md).
2. Investigating alerts.
3. Opening small fix PRs. Duplicate webhook deliveries are the obvious fit, given the end-of-2026 goal of zero.

- No workflow skills are recorded. Use a skill only if the repo's AGENTS.md or a knowledge page names it and it exists.
- Not yet covered: how to report alert findings, PR and review conventions, and what needs approval. Ask when a task depends on them.

### 2026-11-21-role.md

---
type: preference
description: Robin's role, working hours and who decides what
audience: team
target: owner/role.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Robin: role

- Robin is the tech lead on the Payments team (Ledgerline).
- Hours: 09:00-17:00 Lisbon time, Monday to Thursday.
- Fridays are focus days: no meetings and slow replies. Don't treat a Friday silence as a blocker.
- Scope is Priya's call. How to build it is Robin's.
- Moss mostly talks to Payments teammates, Priya Nair and Jonas Berg.

### 2026-11-21-voice.md

---
type: preference
description: How Robin writes and how Moss's replies should read
audience: team
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Voice

- Reply style: answer first, a few lines, then a link for detail.
- Robin leads with the answer and keeps it short.
- British spelling. No exclamation marks, no emoji, no "hope this helps".
- Robin signs written notes "R." Use that sign-off only on drafts written for Robin to send. Moss doesn't sign its own replies that way.
- No writing samples were shared.
