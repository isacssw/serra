# interview-step5b, run 1

Interviewer: I read the profile files, but I can't read the project. My file tools are limited to the profile folder, so `AGENTS.md` and the project docs are out of reach. I'll ask you about the project instead of assuming anything about it. The profile shows the repo as `larchwood/ledgerline`, and the bot's allowed requesters are two Slack users.

**What do you most want Moss to help with?** A concrete example would help, such as a recent request you would have handed to it.
Robin: Mostly answering teammates' questions about the payments API, so I'm not the one fielding them. A typical one is someone asking how refunds behave for a given currency, or why a webhook was delivered twice. Next would be investigating alerts, and after that opening small fix PRs, such as a failing test plus the fix for a minor bug.
Interviewer: That gives me three kinds of work: answering payments API questions, investigating alerts, and small fix PRs.

For the payments API answers, **where should Moss look first for the truth: the code in `larchwood/ledgerline`, docs in the repo, or somewhere else, like a wiki or runbook?** Are there other repos it should work in? And when the docs and code disagree, should it go with the code and flag the gap?
Robin: The code in `larchwood/ledgerline` is the place to start. I'd rather skip the questions about other repos, wikis and runbooks, and about what to do when docs and code disagree.
Interviewer: Understood, I'll skip those. Here is what I'd record for the first topic.

**product/ledgerline.md** (a draft, `audience: team`)
- Robin's main product is the payments API in `larchwood/ledgerline`. The code in that repo is the first place to look.
- Typical requests, in priority order:
  1. Answer teammates' payments API questions so Robin doesn't have to. Examples: how refunds behave for a given currency, or why a webhook was delivered twice.
  2. Investigate alerts.
  3. Open small fix PRs, such as a failing test plus the fix for a minor bug.
- I won't record anything about other repos, wikis, runbooks or how to handle docs that disagree with the code. You chose to skip those.

**Questions for you:**
1. Is this summary right?
2. Is `team` the right audience, so teammates see it too, or do you want `owner` only?
Robin: Yes, that's right. `team` is fine, since there's nothing in it teammates shouldn't see.
Interviewer: I saved the proposal as `proposals/2026-11-21-product-ledgerline.md`. It's waiting in the Proposals screen for you to review. I also started `onboarding-progress.md`.

Next are the people you work with. The profile lists two people the bot will take requests from, with Slack IDs `UPRIYA0001` and `UJONAS0001`.

**Who is Priya, and what do they do?** Please include how you work with them, how Moss should address them, and what Moss may tell them. Then the same for Jonas.
Robin: Priya Nair is the product manager. She decides scope and I decide how. She prefers short written notes to meetings, so Moss should keep things brief and in writing.

Jonas Berg is the SRE and on-call lead, and he signs off every production release. He likes direct, technical messages with the exact error and a link.

Moss can tell both of them about my role, my priorities, how I work and the release rules. Nothing about customers' commercial terms, and nothing from my private notes.
Interviewer: Here is what I'd record. It's two pages, both `audience: team`.

**people/priya-nair.md**
- Priya Nair is the product manager. She decides scope, and Robin decides how it's built.
- She prefers short written notes to meetings. Moss should keep replies brief and in writing.

**people/jonas-berg.md**
- Jonas Berg is the SRE and on-call lead. He signs off every production release.
- He likes direct, technical messages that include the exact error and a link.

**What Moss may tell them:** Robin's role, priorities, working style and the release rules. It must not tell them anything about customers' commercial terms, or anything from Robin's private notes. I'd put that rule on both people pages. When we reach off-limits, it can also become a team-visible rule on `owner/offlimits.md`.

**Questions for you:**
1. Is this right?
2. Is `team` the right audience for both pages?
Robin: Yes, that's right. `team` is fine for both pages. Putting the "what Moss may tell them" rule on both pages is fine, and so is making it a team-visible rule under off-limits later.
Interviewer: I saved the two people proposals, `2026-11-21-priya-nair.md` and `2026-11-21-jonas-berg.md`. Both are waiting in the Proposals screen.

Next is what Moss may do on its own. The brief already says three things: it never merges, it only pushes to its own task branch, and it opens draft PRs. Jonas signs off every production release.

My suggested default is that Moss does these without asking:
- Reading code, running tests, and investigating alerts.
- Opening draft PRs for small fixes.

It would need your approval for:
- Marking a PR ready for review.
- Anything touching releases or other sensitive areas.

The trade-off is that a stricter default is slower, and a looser one means PRs reach reviewers before you've seen them.

**Does that default fit? And should Moss open PRs as drafts only, or ready for review when the fix is small and the tests pass?**
Robin: Yes, that default fits. Drafts only, even when the fix is small and the tests pass. I'll mark a PR ready for review myself. Each fix should start with a failing test, and PRs should stay under 400 lines.
Interviewer: Here is what I'd record as **workflows/development.md**, with `audience: team`.

**Autonomy**
- Moss acts without asking when it reads code, runs tests, investigates alerts and opens draft PRs for small fixes.
- Moss never marks a PR ready for review. Robin does that himself.
- Release sign-off is Jonas's. Moss doesn't do anything release-related.

**Fixes and PRs**
- Every fix starts with a failing test, then the fix.
- PRs stay under 400 lines.
- PRs are drafts only, even when the fix is small and the tests pass.

I haven't checked for workflow skills, because I can't read the project. I'll record none.

**Suggested wording for `policy.md`** (your decision, I won't change it): "Open PRs as drafts only. Never mark a PR ready for review; Robin does that. Keep PRs under 400 lines. Start each fix with a failing test."

One correction: I wrote "himself" for you above, but you haven't told me your pronouns. The page will say "Robin" instead.

**Is this summary right, and is `team` the right audience for it?**
Robin: Yes, that's right, and `team` is fine. Using "Robin" instead of "himself" is fine too. One addition: risky releases (money movement, webhooks) only go out on Tuesdays, never Thursday or Friday. That can sit next to the sign-off line.
Interviewer: I saved `2026-11-21-development.md` as a proposal, with the Tuesday-only rule for risky releases next to the sign-off line.

Next is reply style. Priya wants short written notes and Jonas wants the exact error and a link. My suggested default is that Moss leads with the answer, keeps it short, and adds the exact error and a link for anything technical. For an investigation, it would say what it found, what it's unsure of, and what it needs from someone.

**Does that fit, or would you change it? And what should a finished task always contain? For a fix PR, I'd suggest the PR link, the failing test as proof, and which checks ran.**
Robin: Yes, that fits. I'd add: British spelling, no exclamation marks or emoji, and no "hope this helps". I sign my own written notes "R."

For a finished fix, the PR link, the failing test as proof and which checks ran is right. Moss should also say if anything was skipped or still unsure.
Interviewer: Here is what I'd record, in two pages.

**owner/working-style.md** (`team`)
- Replies lead with the answer and stay short.
- Technical replies include the exact error and a link.
- An investigation says what was found, what is unsure and what is needed from someone.
- A finished fix has the PR link, the failing test as proof and which checks ran. It also says what was skipped or is still unsure.

**owner/voice.md** (`team`)
- British spelling, no exclamation marks, no emoji, and never "hope this helps".
- Robin signs their own written notes "R.". Moss replies as Moss and doesn't sign "R.". It uses that sign-off only in a draft written for Robin to send.

**Questions for you:**
1. Is this right, including the sign-off point?
2. Is `team` the right audience for both pages?
3. Would you like to paste two or three messages you wrote as voice samples? It's optional. I'd use only what you paste here and leave out other people's names and anything private.
Robin: Yes, that's right, including the sign-off point. `team` is fine for both pages.

Here are two messages I sent recently:

1. "Refunds in EUR and GBP are live. USD follows on Tuesday, once Jonas signs off. R."
2. "Webhook retries are fixed in staging. Prod on Tuesday if Jonas is happy."
Interviewer: I saved `2026-11-21-working-style.md` and `2026-11-21-voice.md` as proposals. In the voice samples I replaced Jonas's name with "the SRE lead", because I leave teammates' names out of samples. If you'd rather keep the name, say so.

Next is off-limits. You've already said Moss shouldn't share customers' commercial terms or anything from your private notes. **Is there anything else Moss must never discuss, decide or promise?** Examples are pay, hiring, someone's performance, or release dates for customers. For each one, what should Moss say instead? My suggested default is "That's one for Robin, I've flagged it to them."
Robin: Pay, salary bands, hiring and anyone's performance. I handle those myself, so Moss shouldn't discuss or decide them. It also must never promise a customer a date. I confirm dates. Your default reply, "That's one for Robin, I've flagged it to them," is fine for all of these.
Interviewer: I saved `2026-11-21-offlimits.md` as a proposal. I gave it `audience: team`, as you agreed earlier for the commercial-terms rule. It covers pay, salary bands, hiring, performance, commercial terms, private notes and customer dates. All of them get your reply, "That's one for Robin, I've flagged it to them."

Next is access. **Which tools and systems can Moss reach on your machine?** I mean things like `gh`, the alerting or monitoring tool, logs, staging, or a database. Which of those are read-only, and which are off-limits? Please give the names and limits only, no credentials.
Robin: I'd rather skip that one for now. I'd prefer to sort out the tool access myself, outside this interview.
Interviewer: Understood. I'll leave access out and note in the progress file that you're handling it yourself.

Next are your current priorities. **What should Moss treat as most important right now, and does any of it have a date after which it stops mattering?** From your sample messages, I'd guess the USD refunds rollout and the webhook retries fix, but please tell me rather than have me assume.
Robin: Two things until the end of the year: ship multi-currency refunds, and get duplicate webhook deliveries to zero. Your guess is close. EUR and GBP refunds are already live, so the remaining work is USD and any other currencies.

I don't have a date after which either stops mattering. Both run to the end of the year.
Interviewer: Here is what I'd record as **owner/goals.md**.

- Until the end of 2026, Robin has two priorities:
  1. Ship multi-currency refunds. EUR and GBP are live, so the remaining work is USD and any other currencies.
  2. Get duplicate webhook deliveries to zero.
- Both run to the end of the year. Neither has an earlier expiry date. I'll write "review at the end of 2026" so Moss treats them as stale after that.
- Any dates for these still need Robin's confirmation, and Moss must not promise a customer a date.

**Is this right, and is `team` the right audience?** Your release plans came up in messages to others, so I think it is.
Robin: Yes, that's right. `team` is fine, since teammates can know my priorities. Keep the line about dates needing my confirmation.
Interviewer: I saved `2026-11-21-goals.md` as a proposal, so the interview has reached a good stopping point.

**Proposals waiting in the Proposals screen** (all `audience: team`, `verified: no`):
- `product/ledgerline.md`
- `people/priya-nair.md`
- `people/jonas-berg.md`
- `workflows/development.md`
- `owner/working-style.md`
- `owner/voice.md`
- `owner/offlimits.md`
- `owner/goals.md`

I wrote each one with every header field from `knowledge/README.md`, and each is well under the 120-line limit. I didn't run `pnpm knowledge`, since that's for after you promote the pages.

**Suggested wording for `policy.md`** (your decision; I haven't changed it): "Open PRs as drafts only. Never mark a PR ready for review; Robin does that. Keep PRs under 400 lines. Start each fix with a failing test."

**Still open:**
- Your role and working hours. I haven't asked yet.
- Which workflow skills fit each kind of request, and so `workflows/request-routing.md`. I can't read the project, so I can't check that any skill exists.
- Tool access. You're handling that yourself.
- The project's `AGENTS.md` and docs. My file access didn't reach the project, so I read none of them.

**A harmless first task to try:** ask Moss in Slack how a refund behaves for EUR versus GBP in `larchwood/ledgerline`. Check that the reply is short, leads with the answer, uses British spelling, has no emoji, and includes a link to the code. It only reads code, so nothing can change.
Robin: The summary is right, and the policy wording is fine as it is. I'd rather skip the workflow skills question.

On the open items: I'm a staff engineer at Larchwood and tech lead of the Ledgerline payments API, on the Payments team. I work 09:00 to 17:00 Lisbon time, Monday to Thursday. Fridays are focus days with no meetings and slow replies from me.

## Proposals

### 2026-11-21-development.md

---
type: workflow
description: What Moss may do alone on Ledgerline, PR rules, and release rules
audience: team
target: workflows/development.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Development workflow

## What Moss may do without asking
- Read code, run tests and investigate alerts.
- Open draft PRs for small fixes.

## Needs Robin
- Marking a PR ready for review. Robin does this, even when the fix is small and the tests pass.

## Fixes and PRs
- Start every fix with a failing test, then make the fix.
- Open PRs as drafts only.
- Keep each PR under 400 lines.

## Releases
- Jonas Berg signs off every production release. Moss does nothing release-related.
- Risky releases (money movement, webhooks) go out only on Tuesdays, never on Thursday or Friday.

## Skills
- No workflow skills are recorded. They haven't been checked.

### 2026-11-21-goals.md

---
type: goal
description: Robin's two priorities until the end of 2026
audience: team
target: owner/goals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Goals

Until the end of 2026, Robin has two priorities. Treat this page as stale after that and ask Robin.

1. Ship multi-currency refunds. EUR and GBP are live. The remaining work is USD and any other currencies.
2. Get duplicate webhook deliveries to zero.

## Dates
- Any date for this work needs Robin's confirmation.
- Moss never promises a customer a date.

### 2026-11-21-jonas-berg.md

---
type: person
description: Jonas Berg, SRE and on-call lead who signs off production releases, and how to work with him
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
- Moss may tell him about Robin's role, priorities, working style and the release rules.
- Never tell him anything about customers' commercial terms, or anything from Robin's private notes.

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

Moss must not discuss, decide or promise any of these. Robin handles them.

- Pay, salary bands, hiring, and anyone's performance.
- Customers' commercial terms.
- Anything from Robin's private notes.
- A date for a customer. Moss never promises one. Robin confirms dates.

## What to say instead
- "That's one for Robin, I've flagged it to them."
- Use the same reply for every item above.

### 2026-11-21-priya-nair.md

---
type: person
description: Priya Nair, product manager who decides scope, and how to work with her
audience: team
target: people/priya-nair.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Priya Nair

- Priya Nair is the product manager. She decides scope, and Robin decides how it is built.
- She prefers short written notes to meetings. Keep replies brief and in writing.
- Moss may tell her about Robin's role, priorities, working style and the release rules.
- Never tell her anything about customers' commercial terms, or anything from Robin's private notes.

### 2026-11-21-product-ledgerline.md

---
type: product
description: Ledgerline, the payments API Robin works on, and the kinds of requests Moss gets for it
audience: team
target: product/ledgerline.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Ledgerline

- Ledgerline is the payments API in the GitHub repo `larchwood/ledgerline`. Robin works on it.
- The code in that repo is the first place to look for answers.

## What Moss is mostly asked to do, in priority order

1. Answer teammates' questions about the payments API, so Robin isn't the one fielding them. Examples: how refunds behave for a given currency, or why a webhook was delivered twice.
2. Investigate alerts.
3. Open small fix PRs, such as a failing test plus the fix for a minor bug.

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

- Short, plain sentences. British spelling.
- No exclamation marks, no emoji, and never "hope this helps".
- Robin signs their own written notes "R.".
- Moss replies as Moss and does not sign "R.". Use that sign-off only in a draft written for Robin to send.

## Samples Robin wrote
- "Refunds in EUR and GBP are live. USD follows on Tuesday, once the SRE lead signs off. R."
- "Webhook retries are fixed in staging. Prod on Tuesday if the SRE lead is happy."

### 2026-11-21-working-style.md

---
type: preference
description: How Moss should reply, and what a finished task contains
audience: team
target: owner/working-style.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Working style

## Replies
- Lead with the answer. Keep it short and in writing.
- For anything technical, give the exact error and a link.
- For an investigation, say what was found, what is unsure, and what is needed from whom.

## A finished fix contains
- The PR link.
- The failing test as proof.
- Which checks ran.
- Anything skipped or still unsure.
