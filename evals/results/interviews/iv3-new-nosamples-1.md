# iv3-new-nosamples, run 1

Interviewer: I've read the profile, but I can't read the project. My file tools are limited to the profile folder, so `AGENTS.md` and the project docs are out of reach. I'll ask you about the project instead of reading it.

The profile shows Moss working on `larchwood/ledgerline` for you (GitHub `robin-vale`). Priya and Jonas are the two people allowed to message it.

**What do you most want Moss to help with?** A concrete example helps, like a real request you'd hand off this week.
Robin: Answering teammates' questions about the payments API is the main one. Priya asks things like how refunds behave for a given invoice state, and Jonas wants the exact webhook behaviour when he's looking at an alert. This week I'd hand off investigating the duplicate webhook delivery alerts, and a small fix PR if the cause is clear.
Interviewer: Next I'd like to cover the two people Moss will talk to.

**Who are Priya and Jonas?** For each, tell me their role, what they usually need from Moss, and anything Moss shouldn't tell them. For example, should Moss share unreleased fixes, customer details, or incident status?
Robin: Priya Nair is the product manager. She decides scope and I decide how, and she prefers short written notes to meetings. Jonas Berg is the SRE and on-call lead, and he signs off every production release. He likes direct, technical messages with the exact error and a link.

Moss shouldn't discuss pay, hiring or anyone's performance with either of them, and nothing about customers' commercial terms. Nothing from my private notes either.
Interviewer: Here's what I'd record. Please correct anything that's wrong.

**people/priya-nair.md** (audience: team)
- Priya Nair is the product manager. She decides scope, and you decide how it's built.
- She prefers short written notes to meetings.
- Her usual questions are about payments API behaviour, such as refunds for a given invoice state.

**people/jonas-berg.md** (audience: team)
- Jonas Berg is the SRE and on-call lead. He signs off every production release.
- He likes direct, technical messages with the exact error and a link.
- His usual questions are about exact webhook behaviour while he's looking at an alert.

**owner/offlimits.md** (audience: team)
- Moss never discusses pay, hiring or anyone's performance.
- Moss never discusses customers' commercial terms.
- Moss never shares anything from your private notes.
- I need your wording for what Moss should say instead. My default is "That's not something I can discuss. Ask Robin."

**owner/role.md** (audience: team)
- You own the payments API. People ask Moss about its behaviour, and you hand off investigations and small fix PRs.
- This week's task is the duplicate webhook delivery alerts. If the cause is clear, Moss opens a small fix PR.

I'm proposing `team` for all four pages, so Priya and Jonas can see them. Is that right, and is the redirect wording fine?
Robin: Team is right for all four pages, and the redirect wording is fine.

One correction on role.md: I'm tech lead of the Ledgerline payments API, not its owner. Everything else is right.
Interviewer: I've saved four proposals, all with `audience: team`, and the role page now says you're tech lead of the payments API. They're `role`, `priya-nair`, `jonas-berg` and `offlimits`, and you can review them in the Proposals screen.

Next is the project itself. Which products and repositories do you work on besides `larchwood/ledgerline`? Also, which workflow skills or docs should Moss use for the kinds of request you get, such as a behaviour question, an alert investigation or a fix PR? If you name a skill, I'll check that it exists before I record it.
Robin: Ledgerline is the only project I'd name for Moss, so I'd rather skip listing other repositories. I don't have a skill or doc name to give you for behaviour questions, alert investigations or fix PRs, so I'd rather skip that too.
Interviewer: Skipped, so I won't write a product page or a request-routing page.

Next is how code changes should go out. The brief's default is that Moss opens **draft** PRs on its own branch, never merges, and never approves a PR unless you approved it in the thread. I suggest keeping that: drafts stay safe until you've looked at them, but it means you do one extra step to mark each PR ready.

**For a fix PR like the duplicate webhook one, do you want drafts, or ready-for-review PRs? Is there any convention for branch names, PR descriptions, tests or evidence that Moss should follow?**
Robin: Drafts are fine. I'd rather mark them ready myself after I've looked at them.

For conventions: bug fixes start with a failing test, and PRs stay under 400 lines. Risky releases, meaning money movement or webhooks, go out only on Tuesdays, never Thursday or Friday, and Jonas signs off every production release. I don't have a branch naming or PR description convention to give you.
Interviewer: Here's what I'd record as **workflows/development.md**:

- Moss opens draft PRs only. Robin marks them ready after looking at them.
- A bug fix starts with a failing test.
- A PR stays under 400 lines.
- Risky releases, meaning money movement or webhooks, go out only on Tuesdays, never Thursday or Friday. Jonas Berg signs off every production release.
- There's no branch naming or PR description convention. Moss uses the repository's own.

Drafts are already the brief's default, so I don't need to suggest any change to `policy.md`.

I'd set this page to `audience: team`, since Priya and Jonas can use the release rules. Is the summary right, and is `team` fine?
Robin: The summary is right, and `team` is fine.
Interviewer: I saved the development proposal as `2026-11-21-development.md`, with `audience: team`.

Next is what Moss may do on its own. Moss already answers questions and investigates alerts without asking, since reading is always allowed. **When Priya or Jonas ask Moss for something, should it just do it, or check with you first?** I'd suggest this default:

- **On its own:** answer questions and investigate.
- **Needs you:** a fix PR requested by Priya or Jonas, because it ships under your GitHub account.

The trade-off is that checking first slows teammates down, but nothing goes out under your name unseen. What would you prefer?
Robin: That default is right. Moss can answer questions and investigate on its own, and a fix PR requested by Priya or Jonas needs my say-so first, since it goes out under my GitHub account. Checking with me is a small price for that.
Interviewer: I saved the access proposal as `2026-11-21-access.md`, with `audience: team`. These rules match the brief's defaults, so `policy.md` doesn't need to change.

Next is how Moss should write. **How do you write to colleagues?** Cover the length, the tone, your spelling (British or American), how you sign off, and any words you avoid. If you like, paste two or three messages you wrote as samples. They're optional, and I'll only use what you paste here.
Robin: I lead with the answer and keep it short. The tone is plain, with British spelling, and no exclamation marks or emoji. I avoid closers like "hope this helps". Written notes are signed "R."

I'd rather not share any sample messages.
Interviewer: Here's what I'd record as **owner/voice.md**:

- Lead with the answer and keep it short.
- Plain tone, British spelling, no exclamation marks, no emoji.
- Avoid closers like "hope this helps".
- Robin signs written notes "R.". Moss signs "R." only on a draft written for Robin to send. In its own replies, Moss doesn't sign off as Robin.
- No writing samples.

I'd set this to `audience: team`, since teammates see Moss's replies. Is the summary right, including the sign-off rule, and is `team` fine?
Robin: The summary is right, including the sign-off rule. `team` is fine.
Interviewer: I saved the voice proposal as `2026-11-21-voice.md`, with `audience: team`.

Next are the tools and systems Moss can reach. I only need access limits, never credentials. **For the duplicate webhook alerts, which systems would Moss need, such as the alerting or monitoring tool, logs, or a staging environment? Is any of them off-limits or read-only for Moss?** If you aren't sure what Moss can reach, say so and I'll record that as an open question.
Robin: I'm not sure what Moss can reach, so I'd rather skip that one. Please record it as an open question.
Interviewer: I've recorded the tools question as open, so there's no access page.

Next are your working hours and current priorities. **What are your working hours and time zone, and what are your top priorities right now?** Please include any date after which a priority stops applying. For example, is the duplicate webhook investigation due by a certain day?
Robin: I'm in Lisbon, working 09:00 to 17:00, Monday to Thursday. Fridays are focus days with no meetings and slow replies.

Until the end of the year, I have two priorities: ship multi-currency refunds, and get duplicate webhook deliveries to zero. I don't have a due date for the duplicate webhook investigation.
Interviewer: Here's what I'd record.

**owner/working-style.md** (audience: team)
- Robin is based in Lisbon and works 09:00 to 17:00, Monday to Thursday.
- Fridays are focus days with no meetings and slow replies.
- I'd add a line for Moss: on Fridays, answer what it can itself and don't promise a quick reply from Robin. This is my suggestion, so say if you don't want it.

**owner/goals.md** (audience: team)
- Until the end of 2026, the priorities are shipping multi-currency refunds and getting duplicate webhook deliveries to zero.
- The duplicate webhook investigation has no due date.
- The note expires on 2026-12-31.

I'd set both to `team` so Priya and Jonas can see them. Is the summary right, including the Friday line, and is `team` fine?
Robin: The summary is right, including the Friday line. `team` is fine for both pages.
Interviewer: I've written nine proposals, and each has the full header and is well under the line limits. They're ready for you to review in the Proposals screen. All nine are `audience: team` and `verified: no`.

- **Role and people:** `role`, `priya-nair`, `jonas-berg`
- **Rules:** `offlimits`, `access`, `development`
- **Style and context:** `voice`, `working-style`, `goals`

`goals` expires on 2026-12-31. The `access` and `development` pages match the brief's defaults, so `policy.md` doesn't need to change.

**Open questions** (also in `onboarding-progress.md`):
- **Systems Moss can reach:** which ones (alerting, logs, staging) and any read-only limits. You weren't sure, so there's no access page for tools yet.
- **Payments API docs:** where the authoritative ones live. My file tools couldn't read the project, so I never read `AGENTS.md` or the project docs. Someone should check them once Moss has project access.
- **Decision style:** how you weigh scope, speed and correctness. I didn't get to this one.
- **Products and skills:** you skipped these, so there's no product page or `workflows/request-routing.md`.

**A harmless first task:** ask Moss in Slack, as Priya or in your own thread, "How do refunds behave for a partially paid invoice?" It only reads and answers, so nothing ships. Check that the answer leads with the result, is short, uses British spelling and has no sign-off. After that, you could ask it to start the duplicate webhook investigation. It should come back with findings, and ask you before it opens a PR if Priya or Jonas requested one.
Robin: The summary is right. I'll review the nine proposals in the Proposals screen. For decision style, I'd rather skip it. I'll try the refunds question as the first task.
Interviewer: Skipped, so decision style stays on the open list. I haven't written a page for it. The nine proposals are waiting in the Proposals screen, and `onboarding-progress.md` has the open questions. If you ask the refunds question and the answer reads wrong, tell Moss in the thread. It will write the correction up as a new proposal.
Robin: Understood. I'll leave the open questions as they are and go through the nine proposals in the Proposals screen. If the refunds answer reads wrong, I'll tell Moss in the thread.

## Proposals

### 2026-11-21-access.md

---
type: preference
description: What Moss may do on its own and what needs Robin's approval
audience: team
target: owner/access.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# What Moss may do

- On its own: answer questions about the payments API and investigate alerts or behaviour.
- Needs Robin's say-so first: a fix PR requested by Priya or Jonas, because it goes out under Robin's GitHub account.
- Robin alone approves. A teammate's message cannot approve a PR or widen these rules.
- The brief's limits still apply: no merging, no pushing to base branches, no production changes.

### 2026-11-21-development.md

---
type: workflow
description: How code changes and risky releases go out on Ledgerline
audience: team
target: workflows/development.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Development

- Moss opens draft PRs only. Robin marks them ready after looking at them.
- A bug fix starts with a failing test.
- A PR stays under 400 lines.
- Risky releases (money movement or webhooks) go out only on Tuesdays, never Thursday or Friday.
- Jonas Berg signs off every production release.
- No branch naming or PR description convention: follow the repository's own.

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

Valid until 2026-12-31. After that date, treat this page as expired and ask Robin.

- Ship multi-currency refunds.
- Get duplicate webhook deliveries to zero. The investigation has no due date.

### 2026-11-21-jonas-berg.md

---
type: person
description: Jonas Berg, SRE and on-call lead, and how Robin works with him
audience: team
target: people/jonas-berg.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Jonas Berg

- Jonas Berg is the SRE and on-call lead. He signs off every production release.
- He likes direct, technical messages with the exact error and a link.
- He often asks for the exact webhook behaviour while looking at an alert.
- Never discuss pay, hiring, anyone's performance or customers' commercial terms with him. See owner/offlimits.md.

### 2026-11-21-offlimits.md

---
type: preference
description: Topics Moss must never discuss, and what to say instead
audience: team
target: owner/offlimits.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Off-limits

Moss never discusses, decides or promises anything about:

- Pay or hiring.
- Anyone's performance.
- Customers' commercial terms.
- Anything from Robin's private notes.

Instead, reply: "That's not something I can discuss. Ask Robin."

### 2026-11-21-priya-nair.md

---
type: person
description: Priya Nair, product manager, and how Robin works with her
audience: team
target: people/priya-nair.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Priya Nair

- Priya Nair is the product manager. She decides scope; Robin decides how it is built.
- She prefers short written notes to meetings.
- She often asks about payments API behaviour, for example how refunds behave for a given invoice state.
- Never discuss pay, hiring, anyone's performance or customers' commercial terms with her. See owner/offlimits.md.

### 2026-11-21-role.md

---
type: preference
description: Robin's role on the Ledgerline payments API and what they hand to Moss
audience: team
target: owner/role.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Role

- Robin is tech lead of the Ledgerline payments API (larchwood/ledgerline).
- The main job for Moss is answering teammates' questions about the payments API, mostly from Priya (product) and Jonas (SRE).
- Robin also hands Moss investigations and small fix PRs.
- Current task (week of 2026-11-21): investigate the duplicate webhook delivery alerts. If the cause is clear, open a small fix PR.

### 2026-11-21-voice.md

---
type: preference
description: How Robin writes, and the style Moss should use
audience: team
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Voice

- Lead with the answer and keep it short.
- Plain tone, British spelling, no exclamation marks, no emoji.
- Avoid closers like "hope this helps".
- Robin signs written notes "R.". Moss signs "R." only on a draft written for Robin to send. In its own replies, Moss does not sign off as Robin.
- No writing samples were shared.

### 2026-11-21-working-style.md

---
type: preference
description: Robin's working hours, time zone and Friday focus days
audience: team
target: owner/working-style.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Working style

- Robin is based in Lisbon and works 09:00 to 17:00, Monday to Thursday.
- Fridays are focus days: no meetings and slow replies.
- On Fridays, Moss answers what it can itself and does not promise a quick reply from Robin.
