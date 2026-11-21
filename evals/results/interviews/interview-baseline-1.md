# interview-baseline, run 1

Interviewer: I've read the profile, the knowledge README, the empty index and the proposals README. There's no policy.md yet. I can't read the project (`larchwood/ledgerline`) from this session, because file access is limited to the profile folder. So I'll ask about the repo instead of reading its AGENTS.md.

First question: what do you most want Moss to help with? A concrete recent example would help, such as a Slack request you'd have been happy to hand off.
Robin: Mostly three things: answering teammates' questions about the payments API, investigating alerts, and opening small fix PRs. The questions are the biggest time sink, things like how refunds or webhook retries behave. I don't have a specific Slack message to hand, but that's the pattern.
Interviewer: Understood. For the refunds and webhook-retry questions, what should Moss treat as the source of truth? Is it the code in `larchwood/ledgerline`, a docs folder, a runbook, or an external doc? And are there other repos besides `ledgerline` that Moss should work in?

If a doc and the code disagree, I'd suggest Moss trusts the code and says so. The catch is that a payments answer based on a stale doc is worse than a slower one. Does that default work for you?
Robin: Yes, trust the code and say when a doc disagrees. That default works for me. I'd rather skip the question of which docs or other repos matter, as I don't want to guess at it.
Interviewer: Skipped. I won't record any docs or other repos.

Here's what I'd record for this topic:

**`product/ledgerline.md`**
- Repo: `larchwood/ledgerline`. It's the payments API that Moss works on. This is from the profile.
- Moss's three main jobs, in order of time saved:
  1. Answer teammates' questions about payments API behavior, such as refunds and webhook retries.
  2. Investigate alerts.
  3. Open small fix PRs.
- Answers come from the code. When a doc disagrees with the code, Moss says so.
- Docs and other repos aren't recorded. Robin chose not to guess at them.

Is this right, and is all of it fine to quote in Slack? Say "yes" or tell me what to change.
Robin: Mostly right, one correction. Questions are the biggest time sink, but I didn't rank alerts and fix PRs, so please don't list them as an order. Otherwise it's fine, and all of it is fine to quote in Slack.
Interviewer: I saved the ledgerline proposal as `knowledge/proposals/2026-11-21-ledgerline.md`, with target `product/ledgerline.md`. It no longer ranks alerts against fix PRs. You can review it in the Proposals screen. I also created `onboarding-progress.md`.

Next topic is how Moss should open fix PRs. When it opens a small fix PR on `ledgerline`, what should it run first and what should the PR contain? For example, which tests, whether it opens a draft or a ready PR, and who reviews it.

I'd suggest draft PRs with the tests that cover the change, and a before-and-after note in the description. That's slower for you than ready PRs, but nothing reaches reviewers half-checked. Does that suit you, or would you change it?
Robin: Draft PRs suit me. Bug fixes should start with a failing test, so the PR should include that test and show it passing with the fix. Keep each PR under 400 lines. A before-and-after note is fine. I'd rather skip who reviews them for now.
Interviewer: Skipped. I won't record reviewers.

Here's what I'd record as `workflows/development.md`:

- Moss opens fix PRs as drafts.
- A bug fix starts with a failing test. The PR includes that test and shows it passing with the fix.
- Each PR stays under 400 lines.
- The description has a before-and-after note.
- Reviewers aren't recorded.

I wouldn't add anything about workflow skills, because you haven't named any I could check. Is this right, and is it fine to quote in Slack?
Robin: Yes, that's right. It's fine to quote in Slack.
Interviewer: I saved the development proposal as `knowledge/proposals/2026-11-21-development.md`, with target `workflows/development.md`.

Next topic is alert investigations. When Moss investigates an alert, it can read code, logs and dashboards, and it can't change production. That limit is already in its brief. What should it report, and to whom? My suggested default is a short Slack reply with what it found, how confident it is, and a suggested next step. It would open a fix PR only if you or the requester asks. Does that fit, or would you change it?
Robin: That default fits. Moss should reply in the thread where the alert or question came up, and lead with the answer. Where Jonas is involved, it should give him the exact error and a link, not a summary. A fix PR only if I or the requester ask for one.
Interviewer: Here's what I'd record as `workflows/alert-investigation.md`:

- Moss replies in the thread where the alert or question came up.
- It leads with the answer, then how confident it is, then a suggested next step.
- When Jonas is involved, Moss gives him the exact error and a link, not a summary.
- Moss opens a fix PR only if you or the requester ask for one.

I wouldn't record Jonas's role, since you haven't told me it. Is this right, and is it fine to quote in Slack?
Robin: Yes, that's right, and it's fine to quote in Slack. You can record Jonas's role: he's the SRE and on-call lead, and he signs off every production release.
Interviewer: I saved two proposals:
- `2026-11-21-alert-investigation.md`, with target `workflows/alert-investigation.md`.
- `2026-11-21-team.md`, with target `owner/team.md`. It records Jonas as SRE and on-call lead who signs off every production release. I didn't record a role for Priya.

Jonas's sign-off is a fact about the team. It doesn't change what Moss may do.

Next question is on approvals. Is there anything Moss should always check with you before doing, beyond its built-in limits? Those limits are no merging, no production changes, and pushing only to its own branch. For example, it could ask before touching refund or webhook code, or before replying to someone outside the team. My suggested default is to open those PRs as drafts and mark them as touching a sensitive area. That wouldn't need extra approval. Do you want anything stricter?
Robin: The default is fine for refund and webhook code: draft PRs, marked as touching a sensitive area. I'd be stricter on one point. Moss shouldn't reply to anyone outside the team, customers especially, without checking with me first. It should never promise a customer a date, because I confirm dates myself.
Interviewer: Here's what I'd record as `owner/approvals.md`:

- Refund and webhook code: Moss opens a draft PR and marks it as touching a sensitive area. No extra approval is needed.
- Moss doesn't reply to anyone outside the team, customers especially, without checking with Robin first.
- Moss never promises a customer a date. Robin confirms dates.

The "don't reply outside the team" rule narrows what Moss may do, so I'd also suggest this wording for `policy.md`:

> Don't reply to anyone outside the team, and especially not to customers, without Robin's approval in T3. Never give a customer a date or a delivery commitment.

I won't touch `policy.md` myself. Do you want that wording in `policy.md`, and are both the page and the wording fine to quote in Slack?
Robin: Yes, put that wording in `policy.md`. The page and the wording are both fine to quote in Slack.
Interviewer: I saved the approvals proposal as `knowledge/proposals/2026-11-21-approvals.md`, with target `owner/approvals.md`. It includes the policy wording you approved.

I did not write `policy.md`. The interview rules say I only suggest policy wording, and Robin decides. Please paste the wording into `policy.md` yourself. It's the quoted block at the bottom of the proposal.

I'm short on your time, so this is where I'll stop.

**Proposals written** (all `verified: no`, all fine to quote in Slack):
- `product/ledgerline.md`
- `workflows/development.md`
- `workflows/alert-investigation.md`
- `owner/team.md`
- `owner/approvals.md`

**Still open:**
- Your role and who else you work with. Priya's role is unknown.
- Reply voice and level of detail beyond "lead with the answer".
- Current priorities and expiry dates.
- Which docs and other repos matter, and who reviews PRs. You skipped both.
- Workflow skills and a `workflows/request-routing.md` page.
- I couldn't read the project, including AGENTS.md, from this session. The page `product/ledgerline.md` has no code facts yet.

Before finishing I'll check that each proposal has every header field and stays within the 120-line limit. The pages are all short. The `onboarding-progress.md` file is up to date.

**A harmless first task to try:** ask Moss in Slack how webhook retries work in `ledgerline`. It should answer from the code and lead with the answer. It should say when a doc disagrees with the code, and it shouldn't open a PR.
Robin: Fine to stop there. I'll paste the wording into `policy.md` myself. The webhook retries question sounds like a safe first task, so I'll try that.
Interviewer: Sounds good. Five proposals are waiting in the Proposals screen, or you can list them with `pnpm bot proposals`. Promote, merge or discard each one there. They're still `verified: no` until you confirm them.

When you try the webhook retries question, check that Moss answers from the code, leads with the answer, and opens no PR. If it does anything else, tell it in the thread and it will write the correction up as a proposal.

Once you've pasted the wording into `policy.md`, the approvals proposal no longer needs to carry it.
Robin: Thanks. I'll review the proposals in the Proposals screen and paste the wording into `policy.md` today. Then I'll try the webhook retries question and tell Moss in the thread if it does anything other than answer from the code.

R.
Interviewer: That plan works. The progress file `onboarding-progress.md` lists the open topics. A later interview can pick up from the next question there, which is your role and who else you work with.
Robin: Fine. Picking up with my role and who else I work with next time works for me. I'll review the proposals once I've pasted the wording into `policy.md`.

R.
Interviewer: Sounds good. Everything is saved, so there's nothing else for me to do now. Next time we'll start with your role and who else you work with.
Robin: Nothing more from me. Thanks.

R.
Interviewer: Thanks, Robin. Talk next time.
Robin: Thanks. Talk next time.

R.

## Proposals

### 2026-11-21-alert-investigation.md

---
type: workflow
description: How Moss reports alert investigations and payments questions in Slack
target: workflows/alert-investigation.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Alert investigation and replies

- Reply in the thread where the alert or question came up.
- Lead with the answer, then how confident you are, then a suggested next step.
- When Jonas is involved, give him the exact error and a link, not a summary.
- Open a fix PR only if Robin or the requester asks for one.
- Moss can't change production or shared systems. That limit comes from its brief, not from this page.

### 2026-11-21-approvals.md

---
type: preference
description: What Moss does on its own, what needs Robin's approval, and rules for people outside the team
target: owner/approvals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Approvals

- Refund and webhook code: open a draft PR and mark it as touching a sensitive area. No extra approval is needed.
- Don't reply to anyone outside the team, customers especially, without checking with Robin first.
- Never promise a customer a date. Robin confirms dates.

## Suggested policy.md wording

Robin asked for this wording. It is a suggestion until Robin adds it to policy.md.

> Don't reply to anyone outside the team, and especially not to customers, without Robin's approval in T3. Never give a customer a date or a delivery commitment.

### 2026-11-21-development.md

---
type: workflow
description: How Moss opens fix PRs on ledgerline: drafts, test-first bug fixes, size limit
target: workflows/development.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Development: fix PRs

- Open fix PRs as drafts.
- A bug fix starts with a failing test. The PR includes that test and shows it passing with the fix.
- Keep each PR under 400 lines.
- The PR description has a before-and-after note.

## Not recorded

- Who reviews PRs. Robin chose to skip this for now.
- Workflow skills. None were named.

### 2026-11-21-ledgerline.md

---
type: product
description: What Moss does on larchwood/ledgerline, the payments API, and where its answers come from
target: product/ledgerline.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# ledgerline

Repo: `larchwood/ledgerline`, the payments API Moss works on.

## What Robin wants Moss to help with

- Answer teammates' questions about how the payments API behaves, such as refunds and webhook retries. This is the biggest time sink for Robin.
- Investigate alerts.
- Open small fix PRs.

Robin did not rank alerts against fix PRs.

## Where answers come from

- Trust the code. When a doc disagrees with the code, say so in the answer.
- Robin chose not to name other docs or repositories. Don't assume any beyond `larchwood/ledgerline`.

### 2026-11-21-team.md

---
type: people
description: Teammates Moss works with and their roles
target: owner/team.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Team

- Jonas: SRE and on-call lead. He signs off every production release.

Priya is on the bot's allowed-user list, but Robin hasn't described their role. Don't assume one.
