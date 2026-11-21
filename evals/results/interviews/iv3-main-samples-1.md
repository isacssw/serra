# iv3-main-samples, run 1

Interviewer: I read the profile files. There's no policy.md yet, and the knowledge index is empty. My file tools can't read the project folder, so I can't read its AGENTS.md or docs. That means I'll ask you about the repo (`larchwood/ledgerline`) instead of reading it myself.

First question: **What do you most want Moss to help with?** A concrete example would help, such as a recent request you wish you could have handed off.
Robin: Three things: answering teammates' questions about the payments API, investigating alerts, and opening small fix PRs. The one I'd hand off first is alert investigation, especially duplicate webhook deliveries, since getting those to zero is a priority until the end of the year.
Interviewer: Understood. Next I'd like a concrete example of alert investigation, using duplicate webhook deliveries.

Think of the last duplicate-delivery alert you dealt with. Where did you start, for example the alert itself, logs, a dashboard or the code? What did you check next, and what counted as "done"? Did that mean a root-cause write-up, a fix PR, or a note to a teammate?

Please also say which systems Moss can reach for this, such as logs, the alerting tool or the database. I'll record access limits only, never credentials.
Robin: I'd rather skip the specific alert and the list of systems Moss can reach. For "done", a fix starts with a failing test and goes up as a PR under 400 lines. Anything touching webhooks goes out on a Tuesday, once Jonas has signed off. If it needs a note to Jonas, give him the exact error and a link.
Interviewer: Here's what I'd record. I haven't written anything yet.

**owner/goals.md**
- Moss helps with three things: answering teammates' questions about the payments API, investigating alerts, and opening small fix PRs.
- Alert investigation is the first thing to hand off.
- Until the end of 2026, the priority is getting duplicate webhook deliveries to zero.

**workflows/development.md**
- A fix starts with a failing test.
- The PR stays under 400 lines.
- Anything touching webhooks goes out on a Tuesday, after Jonas has signed off.
- If Jonas needs a note, it gives the exact error and a link.
- I'm leaving out specific alerts and the list of systems Moss can reach, as you asked.

**Suggested wording for policy.md (your decision):** "Moss may prepare webhook changes but never merges or ships them. Release is on a Tuesday, after Jonas has approved the PR." This fits the bot's existing limits. It doesn't widen them.

I have two questions:
1. Is the summary right? Are you also fine with Moss quoting all of it in Slack?
2. Does the 400-line limit include tests? My default is yes, because it's simpler and keeps PRs small.
Robin: Mostly right, with two corrections. The priorities are also shipping multi-currency refunds, not only the webhook duplicates. The Tuesday rule covers money movement as well as webhooks, and never Thursday or Friday. Moss can quote all of it in Slack, and the policy wording is fine.

I'd rather skip the question about whether tests count towards the 400 lines.
Interviewer: I saved two proposals, `owner/goals.md` and `workflows/development.md`, in `knowledge/proposals/`. Both are marked `verified: no`, and you can review them in the Proposals screen. I also wrote `onboarding-progress.md`, which doesn't show in the queue.

I didn't touch `policy.md`. The wording you approved is in the progress file for you to apply: "Moss may prepare webhook and money-movement changes but never merges or ships them. Release is on a Tuesday, after Jonas has approved the PR. Never Thursday or Friday."

Next question: **Which products and repositories do you work on, and which workflow skills fit each kind of request?** I'll check that each skill exists before I record it. I'd also like to know how you want questions about the payments API answered, for example short with a code pointer or a longer explanation.
Robin: I work on one product, Ledgerline, the payments API covering invoices, refunds and webhooks. The repo is larchwood/ledgerline. I'd rather skip the question about workflow skills.

For questions about the payments API, lead with the answer and keep it short, with a code pointer where it helps. No long explanations unless someone asks for more.
Interviewer: Here's what I'd record. I haven't written anything yet.

**product/ledgerline.md**
- Ledgerline is the one product Robin works on. It's a payments API covering invoices, refunds and webhooks.
- The repo is `larchwood/ledgerline`.
- Owner: Robin works on it. I haven't recorded other owners, because you haven't named any.
- I'm not recording where the authoritative docs live, because I couldn't read the project and you haven't said.

**owner/voice.md**
- For payments API questions, lead with the answer and keep it short.
- Add a code pointer (`path:line`) where it helps.
- Give a longer explanation only when someone asks for more.

You skipped workflow skills, so there will be no `workflows/request-routing.md`. Moss will use only the skills the repo itself names.

Is that right? Once you confirm, I'll write both proposals. If you'd like the docs location included, tell me where the authoritative docs for the payments API live. For example, it could be a path in the repo or a link.
Robin: Yes, that's right, with one small correction: I'm the tech lead on Ledgerline, within the Payments team. I'd rather skip the question about where the docs live. You can write both proposals.
Interviewer: I wrote both proposals: `product/ledgerline.md` and `owner/voice.md`. They sit in `knowledge/proposals/` for you to review. I also updated `onboarding-progress.md`.

Next question: **What can Moss do on its own, and what needs approval and from whom?** For example, can it open draft PRs without asking, and who besides you can approve? Also, who are Priya and Jonas? They're the allowed users, but I only know that Jonas signs off on webhook changes.
Robin: Moss can answer questions about the payments API, investigate alerts and open small fix PRs without asking me. It shouldn't merge or ship anything. Jonas signs off every production release, and I decide anything else.

Priya Nair is the product manager. She decides scope and I decide how, and she prefers short written notes to meetings. Jonas Berg is the SRE and on-call lead. He likes direct, technical messages with the exact error and a link.

Moss shouldn't touch pay, hiring or anyone's performance, and it should never promise a customer a date. I confirm dates.
Interviewer: Here's what I'd record. I haven't written anything yet.

**owner/access.md** (what Moss may do)
- Without asking, Moss can answer payments API questions, investigate alerts and open small fix PRs.
- It never merges or ships anything.
- Jonas signs off every production release. Robin decides anything else.
- Moss stays out of pay, hiring and anyone's performance.
- Moss never promises a customer a date. Robin confirms dates.

**owner/team.md**
- Priya Nair is the product manager. She decides scope and Robin decides how. She prefers short written notes to meetings.
- Jonas Berg is the SRE and on-call lead. He likes direct, technical messages with the exact error and a link.

One flag: Moss can quote every page in Slack, including to Priya and Jonas. The team page would therefore be visible to both of them. Are you happy with that wording?

Is the summary right? One small clarification: "open small fix PRs without asking" means draft PRs, as in the bot's standing rules. Do you want it recorded that way?
Robin: Yes, the summary is right, and I'm happy with the team page wording. Priya and Jonas can see it, as the descriptions only say who they are and how they like to work. Draft PRs is fine, record it that way.
Interviewer: I wrote two more proposals, `owner/access.md` and `owner/team.md`, in `knowledge/proposals/`. Both are marked `verified: no`.

That's six proposals so far: goals, development, ledgerline, voice, access and team.

Next question: **Think of a recent decision where scope, speed and correctness pulled against each other.** What did you choose and why? Please also tell me what a finished task from Moss should contain. For example, a PR link, proof of the fix, or a note to Jonas.
Robin: I'd rather skip the question about a recent decision. A finished task from Moss is a draft PR under 400 lines, with the failing test that proves the fix. If it touches webhooks or money movement, it also needs a short note to Jonas with the exact error and a link, so he can sign off ahead of a Tuesday release.
Interviewer: Here's the change I'd make. I haven't written anything yet.

I'd rewrite `workflows/development.md` so it covers what a finished task contains. The release timing and fix rules stay as they are.

**A finished task is:**
- A draft PR under 400 lines.
- The failing test that proves the fix, included in the PR.
- For anything touching webhooks or money movement, a short note to Jonas with the exact error and a link. That lets him sign off ahead of a Tuesday release.

I'm skipping the "recent decision" topic, so there will be no `owner/decisions.md`.

Is that right? Once you confirm, I'll update the draft and finish with the open questions and a first task to try.
Robin: Yes, that's right. One addition: the Tuesday rule for risky releases also applies here, so the note to Jonas is for anything touching webhooks or money movement, and it ships on a Tuesday, never Thursday or Friday. Go ahead and update the draft.
Interviewer: I wrote six proposals in `knowledge/proposals/`. Each has the full header (`type`, `description`, `target`, `written`, `verified: no`, `sources`) and is well under the 120-line limit. I checked that by reading what I wrote, not by running `pnpm knowledge`. Review them in the Proposals screen or with `pnpm bot proposals`.

| File | Target |
|---|---|
| `2026-11-21-goals.md` | `owner/goals.md` |
| `2026-11-21-development.md` | `workflows/development.md` (now includes what a finished task contains) |
| `2026-11-21-ledgerline.md` | `product/ledgerline.md` |
| `2026-11-21-voice.md` | `owner/voice.md` |
| `2026-11-21-access.md` | `owner/access.md` |
| `2026-11-21-team.md` | `owner/team.md` |

**Policy wording for you to apply.** I didn't edit `policy.md`: "Moss may prepare webhook and money-movement changes but never merges or ships them. Release is on a Tuesday, after Jonas has approved the PR. Never Thursday or Friday."

**Still open, because you skipped or I couldn't reach them:**
- Which tools and systems Moss can reach for alert investigation.
- Where the authoritative payments API docs live.
- Which workflow skills apply, so there is no `workflows/request-routing.md`.
- Whether tests count towards the 400-line limit.
- A recent scope, speed and correctness decision, so there is no `owner/decisions.md`.
- Working style, and reply style for alerts and PRs.
- The project's AGENTS.md. My file tools couldn't read the project folder, so that's still unread.
- A target date for multi-currency refunds.

**A harmless first task.** Ask Moss in Slack a read-only question about the payments API, for example "How does Ledgerline decide when to retry a webhook delivery?" You should get a short answer with a `path:line` pointer. It changes nothing, and it shows whether the reply style and the code pointers work. Later, try "investigate the duplicate webhook delivery alerts and tell me what you find, don't change anything" to test the alert workflow.
Robin: The summary is right, and the policy wording is fine. I'll apply it myself.

The open items can stay open for now. On the multi-currency refunds date, I'd rather leave it out, since I confirm dates. I'll try the webhook retry question in Slack first.
Interviewer: Sounds good. I'll leave the multi-currency refunds date out. The six proposals are waiting in the Proposals screen, and `onboarding-progress.md` lists the open items for the next interview.

Once you've tried the webhook retry question, you can promote the proposals you're happy with. Moss reads them as drafts (`verified: no`) until you do.
Robin: Thanks. I'll try the webhook retry question in Slack first, then review the proposals and promote the ones that read right. R.
Interviewer: Sounds good, Robin. If the retry answer comes back too long or without a code pointer, tell Moss in the thread. It will write that up as a correction proposal. Everything else is in the Proposals screen when you're ready.
Robin: Will do. If the answer comes back too long or missing the pointer, I'll say so in the thread. R.
Interviewer: Sounds good. The interview is finished for now. The six proposals are in the Proposals screen, and `onboarding-progress.md` lists the open items for next time.
Robin: Thanks. That's everything for now. R.
Interviewer: Thanks, Robin. The proposals and the progress notes are saved, and we can pick up the open items in the next interview.
Robin: Thanks. Speak next time. R.

## Proposals

### 2026-11-21-access.md

---
type: preference
description: What Moss may do without asking, what it must not do, and who approves what.
target: owner/access.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Autonomy and approval

## Moss may do without asking Robin
- Answer questions about the payments API.
- Investigate alerts.
- Open small fix PRs, as drafts.

## Moss must not
- Merge or ship anything.
- Touch pay, hiring or anyone's performance.
- Promise a customer a date. Robin confirms dates.

## Who approves
- Jonas signs off every production release.
- Robin decides anything else.
- Release timing rules: see workflows/development.md.

This page doesn't widen the bot's permission limits. Only Robin can do that, in a separate, explicit instruction.

### 2026-11-21-development.md

---
type: preference
description: How fix PRs are built, what a finished task contains, and when webhook and money-movement changes may go out.
target: workflows/development.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Development workflow

## Fixes
- Start with a failing test, then make the fix.
- Keep the PR under 400 lines. Robin didn't say whether tests count towards this, so ask if a PR is near the limit.

## A finished task
- A draft PR under 400 lines.
- The failing test that proves the fix, included in the PR.
- If it touches webhooks or money movement: a short note to Jonas with the exact error and a link, so he can sign off ahead of a Tuesday release.

## Release timing
- Changes touching webhooks or money movement ship on a Tuesday only, after Jonas has signed off.
- Never on a Thursday or a Friday.
- Moss prepares the PR. It never merges or ships it (see the bot's standing limits).

## Notes to Jonas
- Give him the exact error and a link. He likes direct, technical messages.

### 2026-11-21-goals.md

---
type: preference
description: What Robin wants Moss to help with and the current priorities.
target: owner/goals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Goals

## What Moss helps with
- Answering teammates' questions about the payments API.
- Investigating alerts. This is the first thing Robin wants to hand off.
- Opening small fix PRs.

## Current priorities
- Get duplicate webhook deliveries to zero. This applies until the end of 2026 (expires 2026-12-31).
- Ship multi-currency refunds. No target date was given.

## Not covered yet
- Which alerts, systems and tools Moss can reach: Robin chose to skip this. Don't assume access.

### 2026-11-21-ledgerline.md

---
type: product
description: What Ledgerline is, its repo, and Robin's role on it.
target: product/ledgerline.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Ledgerline

- Ledgerline is a payments API covering invoices, refunds and webhooks.
- Repo: `larchwood/ledgerline`.
- Robin is the tech lead on Ledgerline, within the Payments team. Robin works on no other product.
- Current priorities: see owner/goals.md.
- Release rules for webhook and money-movement changes: see workflows/development.md.

## Not recorded
- Other owners, and where the authoritative docs live. Robin chose to skip these. Read the repo's own docs and AGENTS.md instead.
- Workflow skills: none are recorded. Use only skills that the repo or an indexed page names.

### 2026-11-21-team.md

---
type: reference
description: Who Priya and Jonas are and how each prefers to be written to.
target: owner/team.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Team

- **Robin**: tech lead on Ledgerline, in the Payments team. Robin decides how things are built.
- **Priya Nair**: product manager. She decides scope. She prefers short written notes to meetings.
- **Jonas Berg**: SRE and on-call lead. He signs off production releases. He likes direct, technical messages with the exact error and a link.

### 2026-11-21-voice.md

---
type: preference
description: How Robin wants payments API questions answered.
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Reply style

## Payments API questions
- Lead with the answer and keep it short.
- Add a code pointer (`path:line`) where it helps.
- Give a longer explanation only when someone asks for more.

## Not covered yet
- Style for alert investigations and PR replies. Robin hasn't said.
