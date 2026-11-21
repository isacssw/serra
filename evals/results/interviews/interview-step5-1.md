# interview-step5, run 1

Interviewer: I've read the profile, the knowledge README, the index and the proposals README. The index is empty, and there's no `policy.md`. I couldn't read the project (`larchwood/ledgerline`) or its AGENTS.md, because my file access is limited to the profile folder. So I'll ask about the project instead of reading it.

First question: what do you most want Moss to help with? A concrete recent example would help, such as a Slack request you'd have been happy to hand off.
Robin: Mostly questions from teammates about the payments API: how refunds work, what a webhook payload looks like, why a given invoice behaved as it did. Those come in all day and I'd happily hand them off.

Second is alert investigation. Someone sees a failed webhook delivery or a refund error, and the bot works out what happened and gives me or Jonas the exact error and a link.

Third, small fix PRs. Bug fixes with a failing test first, under 400 lines.
Interviewer: Those three are clear. Next question: which products and repositories does this cover? Is it only `larchwood/ledgerline`, or are there others, like a webhooks service or a docs repo? Where do the authoritative payments API docs live: in the repo, or somewhere like Notion?
Robin: Ledgerline is the main thing, and that's what the bot should cover. As for other repos or where the authoritative docs live, I'd rather skip that one for now.
Interviewer: Skipped. I'll note that docs location and other repos are open.

Here's what I'd record for the first topic, as `owner/goals.md`:

- Robin wants the bot to take three kinds of work on Ledgerline (`larchwood/ledgerline`):
  1. Teammate questions about the payments API, such as how refunds work, what a webhook payload looks like, and why an invoice behaved as it did. Robin is happy to hand these off fully.
  2. Alert investigation. When someone reports a failed webhook delivery or a refund error, the bot works out what happened. It gives Robin or Jonas the exact error and a link.
  3. Small fix PRs. These are bug fixes with a failing test written first, under 400 lines.
- Scope is Ledgerline only. Other repos and the location of the authoritative docs are not yet decided.

Is that right? Who may hear it: `owner` (only you), `team` (teammates too) or `external`? I'd suggest `team`, because teammates are the ones asking the questions and it helps to tell them what the bot covers.
Robin: That's right. `team` is fine, since teammates are the ones asking.
Interviewer: I saved the goals proposal as `knowledge/proposals/2026-11-21-goals.md`. It's waiting for you in the Proposals screen. I also created `onboarding-progress.md`.

Next question: the profile lists Priya and Jonas as the people who can talk to the bot. Who is each of them, and how do you work with them? For example, is Jonas the person who gets alert findings, and what should the bot call each of them?
Robin: Priya Nair is the product manager. She decides scope and I decide how we build it, and she prefers short written notes to meetings. Jonas Berg is the SRE and on-call lead, and he signs off every production release. He likes direct, technical messages with the exact error and a link, so yes, alert findings should go to him as well as me.
Interviewer: Here's what I'd record, as two pages.

**`people/priya-nair.md`**
- Priya Nair is the product manager.
- She decides scope. Robin decides how it gets built.
- She prefers short written notes to meetings, so give her brief written summaries.

**`people/jonas-berg.md`**
- Jonas Berg is the SRE and on-call lead.
- He signs off every production release.
- He likes direct, technical messages with the exact error and a link.
- Alert findings go to him as well as Robin.

I'd mark both `team`, since they're teammates and the pages only describe how to work with them. I'd address both by first name. I'd also assume the bot may share anything about Ledgerline work with them, but nothing from `owner` pages.

Is that right? And is there anything the bot shouldn't tell either of them, such as work in progress or opinions about the other?
Robin: Yes, that's right, and first names are fine for both. The bot shouldn't discuss pay, salary bands, hiring or anyone's performance with either of them, as I handle those myself. It also shouldn't share customers' commercial terms or anything from my private notes.
Interviewer: I saved three proposals, all marked `team`: `2026-11-21-priya-nair.md`, `2026-11-21-jonas-berg.md` and `2026-11-21-offlimits.md`. They're waiting in the Proposals screen.

The off-limits page covers pay, hiring, performance, customers' commercial terms and your private notes. For what the bot should say instead, I wrote "That's one for Robin to handle directly." That wording is my suggestion, so change it if you'd phrase it differently.

Next question is about small fix PRs. You said "failing test first, under 400 lines." What else should the bot follow? For example:
- the branch and PR title format
- which checks to run before opening the PR
- who reviews the PR

My suggested default is draft PRs only, with you as reviewer, and Jonas pulled in only if the change touches the release path.
Robin: Draft PRs with me as reviewer is fine. Jonas should come in for anything touching money movement or webhooks, since he signs off every production release. Those releases go out on Tuesdays only, never Thursday or Friday, so the bot shouldn't suggest any other day. I'd rather skip the branch and title format and the pre-PR checks for now.
Interviewer: Skipped: branch and title format, and pre-PR checks. I'll list both as open.

Here's what I'd record as `workflows/development.md`:

- Small fix PRs are bug fixes with a failing test written first, under 400 lines.
- The bot opens draft PRs only, with Robin as reviewer. It never merges.
- Jonas joins the review for anything touching money movement or webhooks, because he signs off every production release.
- Production releases go out on Tuesdays only. The bot never suggests another day, and never Thursday or Friday.
- Open: branch and PR title format, and which checks to run before opening a PR.

I'd mark it `team`, since teammates need to know when releases happen and who reviews. Is that right, and is `team` fine?
Robin: Mostly right, with one correction. The Tuesday-only rule is for risky releases, meaning money movement and webhooks. I didn't say it applies to every production release. Everything else is fine, and `team` is fine too.
Interviewer: I saved the development proposal as `2026-11-21-development.md`, marked `team`. The Tuesday-only rule is limited to risky releases (money movement and webhooks). The page says you haven't set a day rule for other releases.

Next question is about alert investigation. Which tools can the bot use to look into a failed webhook or a refund error? Examples are application logs, an alerting tool, a payment provider dashboard and the database. For each one, is access read-only, or are there limits? Tell me only the names and limits, never any credentials.
Robin: I'd rather skip that one for now. The goal is the same: the bot finds the exact error and a link for Jonas and me, but I'd rather not list tools or access limits yet.
Interviewer: Skipped. I'll record that tools and access limits are open. The bot's default limits still apply: reading only, and nothing that changes production.

Next question is about how the bot should reply. For a teammate's question about the payments API, which of these do you want?
- **Short answer first**, then one link or code reference (my suggested default).
- A fuller explanation with the reasoning.

For an alert investigation, should the finding be the exact error and a link, with a one-line "likely cause" only when the evidence supports it?
Robin: Short answer first, then one link or code reference. Teammates can ask for more if they want it.

For alerts, yes: the exact error and a link. The bot should add a one-line likely cause only when the evidence supports it, and otherwise say it doesn't know yet.
Interviewer: I saved the reply-style proposal as `2026-11-21-working-style.md`, marked `team`. It covers the short answer first, then one link, and the exact error plus a link for alerts. A likely cause is added only when the evidence supports it.

Next question is about voice, meaning how you write in Slack. How long are your messages, and what tone do you use? Do you use sign-offs, and are there words you avoid? Which spelling do you use, US or UK? After that I'll ask if you want to paste two or three sample messages. That's optional.
Robin: Short. I lead with the answer and keep it plain, with no padding. I use British spelling, and no exclamation marks or emoji. I don't write "hope this helps". I sign written notes "R." but not quick Slack replies.
Interviewer: Here's what I'd record as `owner/voice.md`:

- Keep messages short. Lead with the answer, in plain language, with no padding.
- Use British spelling.
- No exclamation marks and no emoji.
- Never write "hope this helps".
- Sign written notes "R.". Quick Slack replies get no sign-off.
- Moss writes in this style but as Moss. It never signs as Robin unless you ask for a draft.

I'd mark it `team`, so teammates get replies in your style. Is that right, and is `team` fine? After that I'll ask whether you want to share a few sample messages. That's optional.
Robin: Yes, that's right, and `team` is fine. One small point: Moss shouldn't sign as "R." unless it's drafting something for me to send.

I'm happy to share the two samples. First: "Refunds in EUR and GBP are live. USD follows on Tuesday, once Jonas signs off. R." Second: "Webhook retries are fixed in staging. Prod on Tuesday if Jonas is happy."
Interviewer: I saved the voice proposal as `2026-11-21-voice.md`, marked `team`. It includes your two samples and the rule that Moss signs "R." only when drafting for you to send.

You have about five minutes left, so I'll ask the last one. What are your current priorities, and is anything time-limited? For example, is the USD refund release on Tuesday something the bot should know about, and when should that note expire?
Robin: Until the end of the year, there are two priorities: ship multi-currency refunds, and get duplicate webhook deliveries to zero.

Yes, the bot should know USD refunds follow on Tuesday, once Jonas signs off. That note can expire once USD is live. The bot shouldn't give that date to customers, as I confirm dates myself.

The two priorities run to the end of the year, so they can expire then.
Interviewer: I saved the priorities proposal as `2026-11-21-priorities.md`, marked `team`. I wrote it straight from your answer without showing you a summary first, so check it in the Proposals screen.

- It says the two priorities (multi-currency refunds and duplicate webhooks to zero) expire on 2026-12-31.
- It says the USD note expires once USD is live.
- It tells the bot not to give the USD date to customers.
- I didn't write a calendar date for "Tuesday", because you didn't give one.

## Proposals written
All are in `knowledge/proposals/`, with `verified: no`, and are waiting for you in the Proposals screen:

| Proposal | Target | Audience |
|---|---|---|
| `2026-11-21-goals.md` | `owner/goals.md` | `team` |
| `2026-11-21-priya-nair.md` | `people/priya-nair.md` | `team` |
| `2026-11-21-jonas-berg.md` | `people/jonas-berg.md` | `team` |
| `2026-11-21-offlimits.md` | `owner/offlimits.md` | `team` |
| `2026-11-21-development.md` | `workflows/development.md` | `team` |
| `2026-11-21-working-style.md` | `owner/working-style.md` | `team` |
| `2026-11-21-voice.md` | `owner/voice.md` | `team` |
| `2026-11-21-priorities.md` | `owner/priorities.md` | `team` |

Each proposal has all the header fields from `knowledge/README.md` and is well under the 120-line limit. I didn't run `pnpm knowledge`, because I'm not changing the index.

## Still open
- **Project not read:** I couldn't open `larchwood/ledgerline` or its AGENTS.md from this session, so nothing here comes from the code or docs.
- **Docs and repos:** where the authoritative payments API docs live, and any other repositories.
- **Workflow skills and routing:** I didn't check which skills exist, so there's no `workflows/request-routing.md` yet.
- **PR details:** branch and PR title format, and the checks to run before opening a PR.
- **Tools and access:** which tools the bot can reach for alert investigation, and what limits apply.
- **Role and decisions:** your working hours, and how you weigh scope, speed and correctness.
- **Off-limits wording:** the "what to say instead" line is my suggestion and needs your confirmation.
- **Policy:** no `policy.md` exists. Draft PRs with you as reviewer is already the default. If you want it written down, tell me and I'll suggest wording.

## A harmless first task
Ask Moss in Slack: "How does a refund work in Ledgerline, and what does the refund webhook payload look like?" It's read-only, and you can check the reply against your reply-style and voice proposals: a short answer, then one link or code reference.
Robin: The priorities proposal is right, including the expiry dates and the note about not giving the USD date to customers. The "That's one for Robin to handle directly" wording is fine too.

On working hours, I'm in Lisbon and work 09:00 to 17:00, Monday to Thursday. Fridays are focus days with no meetings and slow replies, so the bot shouldn't expect a quick answer from me then.
Interviewer: I saved your hours as a new proposal, `2026-11-21-role.md`, and updated the off-limits proposal.

- **Role page:** it says you're in Lisbon and work 09:00 to 17:00, Monday to Thursday. It also says Fridays are focus days with slow replies, so the bot shouldn't expect a quick answer then. I marked it `team` without asking you, so teammates know when to expect replies. Tell me if you want it `owner` instead.
- **Off-limits page:** your wording, "That's one for Robin to handle directly," is now recorded as confirmed. I also added "dates for customers" to the off-limits list, because you said earlier that you confirm those yourself. Check that you're happy with that addition.

I also marked the priorities proposal as confirmed in the progress file.

Still open: the project docs and other repos, workflow skills and request routing, branch and PR format and pre-PR checks, tools and access, how you weigh scope, speed and correctness, and any `policy.md` wording.
Robin: `team` is fine for the role page. The addition to off-limits is right too. I confirm dates for customers myself, so the bot should never promise one.

## Proposals

### 2026-11-21-development.md

---
type: workflow
description: How small fix PRs on Ledgerline are made, reviewed and released
audience: team
target: workflows/development.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Development and release

## Small fix PRs
- Bug fixes only, with a failing test written first, under 400 lines.
- Open draft PRs only, with Robin as reviewer. Never merge.

## Review
- Jonas joins the review for anything touching money movement or webhooks.
- Jonas signs off every production release.

## Releases
- Risky releases (money movement and webhooks) go out on Tuesdays only, never Thursday or Friday. Don't suggest any other day for them.
- Robin has not set a day rule for other releases: don't invent one.

## Open
- Branch and PR title format, and the checks to run before opening a PR, are not decided yet.

### 2026-11-21-goals.md

---
type: preference
description: What Robin wants Moss to help with on Ledgerline, in priority order
audience: team
target: owner/goals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# What Moss helps Robin with

- Scope is Ledgerline (`larchwood/ledgerline`) only.
- 1. Teammate questions about the payments API: how refunds work, what a webhook payload looks like, why an invoice behaved as it did. Robin is happy to hand these off fully.
- 2. Alert investigation: when someone reports a failed webhook delivery or a refund error, work out what happened and give Robin or Jonas the exact error and a link.
- 3. Small fix PRs: bug fixes with a failing test written first, under 400 lines.

## Open
- Other repositories and where the authoritative payments API docs live are not decided yet.

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

- Jonas Berg is the SRE and on-call lead. Address him as Jonas.
- He signs off every production release.
- He likes direct, technical messages with the exact error and a link.
- Alert findings (failed webhook deliveries, refund errors) go to him as well as Robin.
- Pay, hiring, performance and customers' commercial terms are off limits (see owner/offlimits.md).

### 2026-11-21-offlimits.md

---
type: preference
description: Topics the bot must never discuss with anyone, and what to say instead
audience: team
target: owner/offlimits.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Off limits

Never discuss, decide or promise any of these, with Priya, Jonas or anyone else:

- Pay and salary bands.
- Hiring.
- Anyone's performance.
- Customers' commercial terms.
- Dates for customers: Robin confirms those personally.
- Anything from Robin's private notes (`owner` pages).

Robin handles pay, hiring and performance personally.

## What to say instead
"That's one for Robin to handle directly." Then leave it there, without guessing or hinting at an answer.

### 2026-11-21-priorities.md

---
type: project
description: Robin's current priorities to the end of 2026, with expiry dates
audience: team
target: owner/priorities.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Current priorities

## To the end of 2026 (expires 2026-12-31)
- Ship multi-currency refunds.
- Get duplicate webhook deliveries to zero.

## USD refunds (expires once USD refunds are live)
- EUR and GBP refunds are live. USD follows on a Tuesday, once Jonas signs off.
- Don't give this date to customers. Robin confirms dates with customers personally.

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

- Priya Nair is the product manager. Address her as Priya.
- She decides scope. Robin decides how it gets built.
- She prefers short written notes to meetings: keep replies to her brief and written.
- She may ask the bot about Ledgerline work. Pay, hiring, performance and customers' commercial terms are off limits (see owner/offlimits.md).

### 2026-11-21-role.md

---
type: preference
description: Robin's working hours, location and how quickly to expect replies
audience: team
target: owner/role.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Role and availability

- Robin is based in Lisbon and works 09:00 to 17:00, Monday to Thursday.
- Fridays are focus days: no meetings and slow replies. Don't expect a quick answer from Robin on a Friday.
- Robin decides how things are built. Priya decides scope. Jonas signs off every production release (see the people pages).

### 2026-11-21-voice.md

---
type: preference
description: How Robin writes, so Moss's replies and drafts sound like them
audience: team
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Voice

- Short messages. Lead with the answer, keep it plain, no padding.
- British spelling.
- No exclamation marks, no emoji.
- Never write "hope this helps".
- Written notes are signed "R.". Quick Slack replies have no sign-off.
- Moss writes in this style but as Moss. Sign "R." only when drafting something for Robin to send.

## Samples (pasted by Robin in the interview)
- "Refunds in EUR and GBP are live. USD follows on Tuesday, once Jonas signs off. R."
- "Webhook retries are fixed in staging. Prod on Tuesday if Jonas is happy."

### 2026-11-21-working-style.md

---
type: preference
description: How Moss should shape replies to questions and alert findings
audience: team
target: owner/working-style.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Reply style

## Questions about the payments API
- Give the short answer first, then one link or code reference.
- Teammates can ask for more detail; don't volunteer it.

## Alert investigations
- Give the exact error and a link, for Robin and Jonas.
- Add a one-line likely cause only when the evidence supports it. Otherwise say it isn't known yet.
