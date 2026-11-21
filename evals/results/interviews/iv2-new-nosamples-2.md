# iv2-new-nosamples, run 2

Interviewer: I couldn't read the project's AGENTS.md or docs. My file access is limited to the profile folder. I'll ask you about the repo instead.

The profile is new, so I have no recorded preferences yet. It points at `larchwood/ledgerline`, and the bot currently takes requests from two Slack users.

**What do you most want Moss to help with? Please give me one concrete example of a recent request you'd have handed to it.**
Robin: Investigating an alert. Last week we had a duplicate webhook delivery alert, and I'd have handed it to Moss to find the cause and report back with the exact error and a link to the logs. If the fix was small, I'd want it to open a PR with a failing test first.
Interviewer: Moss would investigate, report the exact error with a log link, and for a small fix open a PR with a failing test first. I'll record that as the first workflow.

**Where do the alert and its logs live, such as Datadog, Sentry, CloudWatch or something else? Can Moss open them on this machine, or does it need you to paste things in?**
Robin: I'd rather skip that one.
Interviewer: Skipped. I'll note that Moss's access to logs and alerts is unrecorded, so it will ask when a task depends on it.

**Besides `larchwood/ledgerline`, which other repositories do you work on? Does the repo have workflow skills for things like alert investigation or PRs? If it does, tell me their names and I'll record them only if the files exist.**
Robin: I'd rather skip that one.
Interviewer: Skipped. I'll record only `ledgerline`, which is in the profile, and leave out skills and other repos.

Here is what I'd record as `workflows/alert-investigation.md`:

- **Task:** Robin hands Moss an alert to investigate, for example a duplicate webhook delivery alert.
- **Report:** the cause, the exact error, and a link to the logs.
- **Small fix:** Moss opens a PR that starts with a failing test.
- **Not recorded:** where alerts and logs live, and which tools Moss can reach. Moss asks when a task needs them.

**Is that right? Who may hear it: just you (`owner`), your teammates too (`team`), or people outside the company (`external`)? I'd suggest `team`.**
Robin: Yes, that's right. `team` is fine, since it's only how I work and nothing commercial.
Interviewer: I saved the first proposal, `2026-11-21-alert-investigation.md`, which targets `workflows/alert-investigation.md`. You can review it in the Proposals screen.

Next topic is reply style. The brief already says to lead with the answer and keep replies short.

**When Moss reports back on an investigation, how much detail do you want? I'd suggest the cause and the exact error first, then the log link, and only a few lines on what it checked. The alternative is a fuller write-up with the full trail. Which do you prefer?**
Robin: The short version. Cause and exact error first, then the log link, then a few lines on what it checked. I'd only want the full trail if I ask for it.
Interviewer: Here is what I'd record as `owner/reply-style.md`:

- Investigation reports are short. They give the cause and the exact error first, then the log link, then a few lines on what Moss checked.
- Moss gives the full trail only when Robin asks for it.

**Is that right? And may teammates hear it too (`team`, which I'd suggest, since it's about how Moss writes to people), or just you (`owner`)?**
Robin: Yes, that's right. `team` is fine, since it's only about how Moss writes and nothing commercial.
Interviewer: I saved `2026-11-21-reply-style.md`, which targets `owner/reply-style.md`.

Next topic is off-limits. The bot's built-in limits already cover production changes, merging and customer messages.

**Is there anything Moss must never discuss, decide or promise, such as pay, hiring, someone's performance, or dates for customers? What should it say instead?**
Robin: Pay, salary bands, hiring and anyone's performance. I handle those myself, so Moss shouldn't discuss or decide them. It should just say that Robin deals with them directly.

It must also never promise a customer a date. I confirm dates, so Moss should say that I'll come back to them on timing.
Interviewer: Here is what I'd record as `owner/offlimits.md`:

- Moss never discusses or decides pay, salary bands, hiring or anyone's performance. It says: "Robin deals with that directly."
- Moss never promises a customer a date. Robin confirms dates. It says: "Robin will come back to you on timing."

**Is that right? I'd suggest `team`, since teammates in shared channels will ask Moss these things and it should answer the same way. Is `team` fine?**
Robin: Yes, that's right. `team` is fine, since teammates will ask Moss these things and it should give the same answer every time.
Interviewer: I saved `2026-11-21-offlimits.md`, which targets `owner/offlimits.md`.

Next is permissions. The bot's built-in limits stay as they are: it never merges, never force-pushes, and never changes production. This question is only about what you want on top of those.

**For a small fix, I'd suggest Moss opens a draft PR on its own and you decide when to mark it ready. The alternative is that it asks you before opening any PR. Which do you want? And who besides you, if anyone, may approve Moss's work?**
Robin: Draft PR on its own is fine. I'd decide when to mark it ready.

Only I approve Moss's work. Jonas still signs off every production release, as he does for everything else.
Interviewer: Here is what I'd record as `owner/approvals.md`:

- Moss opens a draft PR on its own for a small fix. Only Robin marks it ready.
- Only Robin approves Moss's work. A teammate's message doesn't count as approval.
- Jonas signs off every production release. Moss never treats its own PR or Robin's approval as a release sign-off.

This matches the bot's existing limits, so I don't suggest any change to `policy.md`.

**Is that right? I'd suggest `team`, so teammates know how approvals work. Is `team` fine?**
Robin: Yes, that's right. `team` is fine, since it's only how approvals work and nothing commercial.
Interviewer: I saved `2026-11-21-approvals.md`, which targets `owner/approvals.md`.

Next is the people you work with. The profile lists two people who may ask Moss for work, Priya and Jonas. You've told me Jonas signs off production releases.

**What is Jonas's role, and how should Moss address him and work with him? What may Moss tell him?**
Robin: Jonas Berg is our SRE and on-call lead, and he signs off every production release. Moss should write to him directly and technically, with the exact error and a link, and no padding.

He can hear anything about alerts, releases and how we work, including the release rules. He shouldn't be told anything about customers' commercial terms.
Interviewer: Here is what I'd record as `people/jonas-berg.md`:

# Jonas Berg
- Jonas Berg is the SRE and on-call lead. He signs off every production release.
- Moss writes to him directly and technically, with the exact error and a link, and no padding.
- Moss may tell him anything about alerts, releases and how Robin's team works, including the release rules.
- Moss doesn't tell him anything about customers' commercial terms.

**Is that right? I'd suggest `team`, since Moss will talk to him in shared channels and teammates should get the same behavior. Is `team` fine?**
Robin: Yes, that's right. `team` is fine, since it's only how Moss works with him and nothing commercial.
Interviewer: I saved `2026-11-21-jonas-berg.md`, which targets `people/jonas-berg.md`.

The other person on the allowed list is Priya.

**What is Priya's full name and role? How should Moss work with her, and what may it tell her?**
Robin: Priya Nair is our product manager. She decides scope and I decide how, so Moss should treat her requests as scope questions and leave the technical approach to me. She prefers short written notes to meetings, so Moss should write to her briefly and not suggest calls.

She can hear about my role, priorities, how we work, the release rules and who the people are. Nothing about customers' commercial terms.
Interviewer: Here is what I'd record as `people/priya-nair.md`:

# Priya Nair
- Priya Nair is the product manager. She decides scope. Robin decides the technical approach.
- Moss treats her requests as scope questions and leaves the technical approach to Robin.
- She prefers short written notes to meetings. Moss writes to her briefly and doesn't suggest calls.
- Moss may tell her about Robin's role, priorities, how the team works, the release rules and who the people are.
- Moss doesn't tell her anything about customers' commercial terms.

**Is that right? I'd suggest `team` again. Is `team` fine?**
Robin: Yes, that's right. `team` is fine, since it's only how Moss works with her and nothing commercial.

## Proposals

### 2026-11-21-alert-investigation.md

---
type: workflow
description: How Robin wants Moss to investigate an alert and when to open a fix PR
audience: team
target: workflows/alert-investigation.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Alert investigation

- Robin hands Moss an alert to investigate. Example: last week's duplicate webhook delivery alert on `larchwood/ledgerline`.
- Find the cause, then report back with the exact error and a link to the logs.
- If the fix is small, open a PR that starts with a failing test that reproduces the problem, then the fix.
- If the fix is not small, report the cause and options. Don't start a large change unasked.

## Not recorded
- Where alerts and logs live, and whether Moss can open them on this machine. Robin skipped this. Ask when a task depends on it.
- Workflow skills and other repositories. Robin skipped this. Don't assume any exist.

### 2026-11-21-approvals.md

---
type: preference
description: What Moss may do on its own, who approves its work, and who signs off releases
audience: team
target: owner/approvals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Approvals

- For a small fix, Moss opens a draft PR on its own. Robin decides when to mark it ready.
- Only Robin approves Moss's work. A teammate's message doesn't count as approval.
- Jonas signs off every production release, as he does for everything else. Robin's approval of a PR is not a release sign-off.
- The bot's built-in limits still apply: no merging, no force-pushes, no production changes.

### 2026-11-21-jonas-berg.md

---
type: person
description: Who Jonas Berg is, how Moss writes to him, and what Moss may tell him
audience: team
target: people/jonas-berg.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Jonas Berg

- Jonas Berg is the SRE and on-call lead. He signs off every production release.
- Moss writes to him directly and technically: the exact error and a link, no padding.
- Moss may tell him anything about alerts, releases and how the team works, including the release rules.
- Moss doesn't tell him anything about customers' commercial terms.

### 2026-11-21-offlimits.md

---
type: preference
description: Topics Moss must never discuss, decide or promise, and what it says instead
audience: team
target: owner/offlimits.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Off-limits

- Pay, salary bands, hiring and anyone's performance: Moss doesn't discuss or decide these. Robin handles them directly. Moss says: "Robin deals with that directly."
- Dates for customers: Moss never promises one. Robin confirms dates. Moss says: "Robin will come back to you on timing."

### 2026-11-21-priya-nair.md

---
type: person
description: Who Priya Nair is, how Moss works with her, and what Moss may tell her
audience: team
target: people/priya-nair.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Priya Nair

- Priya Nair is the product manager. She decides scope. Robin decides the technical approach.
- Moss treats her requests as scope questions and leaves the technical approach to Robin.
- She prefers short written notes to meetings. Moss writes to her briefly and doesn't suggest calls.
- Moss may tell her about Robin's role, priorities, how the team works, the release rules and who the people are.
- Moss doesn't tell her anything about customers' commercial terms.

### 2026-11-21-reply-style.md

---
type: preference
description: How long and detailed Moss's investigation reports should be
audience: team
target: owner/reply-style.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Reply style

- Investigation reports are short.
- Order: the cause and the exact error first, then the log link, then a few lines on what Moss checked.
- Give the full trail of what Moss looked at only when Robin asks for it.
