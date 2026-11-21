# interview-baseline, run 2

Interviewer: I read the profile, the knowledge README, the empty index and the proposals README. There is no `policy.md` yet, so nothing narrows or widens the bot's default limits.

I couldn't read the project (`larchwood/ledgerline`). My file tools are confined to the profile folder, so `AGENTS.md` and the docs are out of reach. I'll ask you about the project instead of guessing.

**What do you most want Moss to help with?** Please give me a concrete example, such as a recent request you would have handed off if you could.
Robin: Mostly teammates' questions about the payments API, which eat a lot of my week. After that, investigating alerts, especially duplicate webhook deliveries, and opening small fix PRs once the cause is clear. If I could hand off one thing today, it would be the first look at a duplicate-webhook alert: find the cause and, if it's small, open a PR with a failing test.
Interviewer: Understood. Moss would answer payments API questions, investigate alerts and open small fix PRs.

Next I need the workflow for a duplicate-webhook alert. Here is the default I'd suggest:

1. Moss reads the alert and the code and traces the cause.
2. It writes a failing test that reproduces the problem.
3. If the fix is small, it adds the fix and opens a **draft** PR.
4. If the cause is unclear, or the fix would touch payments logic in a risky way, it reports what it found and doesn't open a PR.

The trade-off is that draft PRs keep you as the gate, but every one needs your attention. Ready-for-review PRs would save you a step, but they put unreviewed work in front of your team.

Does that default fit? Please also tell me:
- Where do these alerts show up, for example a Slack channel, PagerDuty or Sentry?
- What counts as "small"? For example, a line limit, or only certain directories.
- Which areas should Moss never fix by itself, such as payment capture or refunds?
Robin: The default fits. Draft PRs, with a failing test first. Small means under 400 lines. Anything touching money movement, so refunds and capture, it should report to me rather than fix. Nothing ships without Jonas signing off, and risky releases like webhooks go out on Tuesdays only.

I'd rather skip where the alerts show up.
Interviewer: Here is what I'd record as `workflows/duplicate-webhook-triage.md`. It is a draft and not yet one of your decisions.

- **Scope:** Moss's top jobs are teammates' payments API questions, alert investigation (duplicate webhook deliveries first) and small fix PRs.
- **Duplicate-webhook alert:**
  1. Find the cause.
  2. Write a failing test that reproduces it.
  3. If the fix is small, add it and open a **draft** PR.
  4. If the cause is unclear, report what Moss found.
- **Small:** under 400 lines.
- **Money movement (refunds, capture):** Moss investigates and reports to Robin. It doesn't fix.
- **Shipping:** nothing ships without Jonas's sign-off. Risky releases such as webhooks go out on Tuesdays only.
- **Left out:** where the alerts show up, as you asked.

Two points to check:
1. Does "Tuesdays only" cover just the release, so Moss can still open a draft PR on any day? That's my assumption.
2. Is all of this fine to quote in Slack, including Jonas's sign-off role? Teammates would see it.

Reply "confirmed", with any corrections, and I'll write the proposal and the progress file.
Robin: Yes, "Tuesdays only" covers the release only. Moss can open a draft PR on any day, and the failing test still comes first. Money movement and webhooks are the risky releases, so both are Tuesday-only.

Yes, all of it is fine to quote in Slack, including Jonas's sign-off. Confirmed.
Interviewer: I saved the proposal as `knowledge/proposals/2026-11-21-duplicate-webhook-triage.md`, with target `workflows/duplicate-webhook-triage.md`. It's in the Proposals screen waiting for your review. I also created `onboarding-progress.md`.

You could add the Jonas sign-off and Tuesday-only rules to `policy.md` so they bind the bot directly. Suggested wording: "Nothing ships without Jonas's sign-off. Releases touching webhooks or money movement go out on Tuesdays only. Money-movement problems (refunds, capture) are reported to Robin, not fixed." Moss's current rules don't enforce any of this. Should I leave it for you to decide? I haven't changed `policy.md`.

Next question: **which products and repositories do you work on?** For payments API questions, where do the authoritative docs live? Moss already knows `larchwood/ledgerline`. I couldn't read its files, so I don't know what docs it has.
Robin: Yes, add those rules to `policy.md`, with your wording. I'd rather the bot be bound by them than rely on the workflow note.

I work on one product, the Ledgerline payments API: invoices, refunds and webhooks. I'd rather skip where the docs live.
Interviewer: I haven't edited `policy.md`. My instructions say I only suggest policy wording and Robin applies it, because it changes the bot's limits. You can paste this in yourself, or add it by whatever route you normally use for `policy.md`:

```
## Owner rules
- Nothing ships without Jonas's sign-off.
- Releases that touch webhooks or money movement (refunds, capture) go out on Tuesdays only. Opening a draft PR on any day is fine.
- Money-movement problems (refunds, capture): investigate and report to Robin. Don't fix them.
- Fix PRs are drafts, with a failing test first, and only when the change is under 400 lines.
```

Here is what I'd record as `product/ledgerline.md`. It's a draft.

- Robin works on one product, the Ledgerline payments API (`larchwood/ledgerline`).
- It covers invoices, refunds and webhooks.
- Refunds and webhooks are the sensitive areas: see the duplicate-webhook workflow and the money-movement rule.
- Robin chose not to record where the docs live. Moss should read the repo's own `AGENTS.md` and docs.
- Fine to quote in Slack.

Is that right? I also need one more answer for the routing page. Which request types should go to a workflow skill, such as a PR review skill or a test-writing skill? I'll check that any skill you name exists before I record it. If you have none, I'll record that and move on.
Robin: Yes, that's right. I'll paste the rules into `policy.md` myself.

I don't have any workflow skills, so record that and move on.
Interviewer: I wrote two more proposals, `2026-11-21-ledgerline.md` (target `product/ledgerline.md`) and `2026-11-21-request-routing.md` (target `workflows/request-routing.md`). The routing page records that you have no workflow skills. I also updated the progress file.

I invented the routing table's wording from what you told me. Check it before you promote it.

Next question: **how much detail should Moss give teammates when it answers payments API questions, and when should it hand a question to you?** For example, a short answer with a code pointer, or a fuller explanation. An example of a question it should always bring to you would help.
Robin: Short answer first, then a code pointer if there's one. It should only give a fuller explanation if the person asks for it. Same style as mine: lead with the answer, no waffle.

It should bring me anything where a customer wants a date, because I confirm dates and it must never promise one. It should also bring me anything on customers' commercial terms, or on pay, hiring or performance. Anything touching money movement, such as a refund bug, comes to me too. A good example is "when will USD refunds be live for this customer?"
Interviewer: Here is what I'd record as `owner/voice.md`, a draft:

- **Style:** Lead with the answer, then a code pointer if there is one. No waffle. Give a fuller explanation only if the person asks. Moss writes in Robin's style but as Moss, not as Robin.
- **Hand to Robin, don't answer:**
  - Anything where a customer wants a date. Robin confirms dates, and Moss never promises one.
  - Customers' commercial terms.
  - Pay, hiring and performance.
  - Anything touching money movement, such as a refund bug.
- **Example:** "When will USD refunds be live for this customer?" goes to Robin.
- **Handing over:** Moss gives what it can first, such as the code facts. Then it says Robin will answer the date or term. Only something Robin alone must do gets a `Needs owner:` line.

Two checks before I write it:
1. The "Handing over" point is my suggestion, taken from the bot's brief. It isn't something you said. Do you want it in?
2. Is this page fine to quote in Slack? It names pay, hiring and performance as topics Moss hands to you, so teammates would see that.

Reply "confirmed", with any corrections, and I'll write it.
Robin: Yes, keep the handing-over point. Moss gives the code facts first, then says I'll answer the date or term. The `Needs owner:` line is only for things I alone must do.

Yes, it's fine to quote in Slack. Teammates can know that pay, hiring and performance come to me. Confirmed.
Interviewer: I saved `2026-11-21-voice.md` (target `owner/voice.md`) and updated the progress file.

Next question, on development conventions: **what are the test command, branch naming and PR format for Ledgerline, and who reviews a draft PR?** I'd guess Jonas, since he signs off, but I won't record that unless you say so. If the repo's `AGENTS.md` already covers this, tell me and I'll skip it. I can't read that file from here.
Robin: I'd rather skip the test command, branch naming and PR format. Moss can read them from the repo. The rules I've already given still apply: failing test first, PRs under 400 lines, and Jonas signs off every production release.

I'd also rather skip who reviews draft PRs. Please don't record Jonas as the reviewer.
Interviewer: I skipped the development conventions and the reviewer as you asked, and I recorded nothing about either. Jonas is recorded only as the person who signs off releases. The progress file notes that Jonas is not the reviewer.

**Proposals written** (all `verified: no`, each under the line limit with every header field):
- `2026-11-21-duplicate-webhook-triage.md` → `workflows/duplicate-webhook-triage.md`
- `2026-11-21-ledgerline.md` → `product/ledgerline.md`
- `2026-11-21-request-routing.md` → `workflows/request-routing.md`
- `2026-11-21-voice.md` → `owner/voice.md`

Review them in the Proposals screen or with `pnpm bot proposals`. Check the routing table, because I worded it from what you told me.

**Still open:**
- Your role and team.
- Tools and access limits.
- Current priorities and expiry dates.
- The `policy.md` rules. You said you'd paste them in yourself.
- The project docs. My file tools couldn't read the project, so I never saw `AGENTS.md`.

**A harmless first task for Moss:** ask it a read-only payments API question in Slack, such as "where do we de-duplicate incoming webhook events?". You should get a short answer with a code pointer and no PR. Then ask it something date-related, like "when will USD refunds be live for customer X?", to check that it hands the question to you and promises nothing.
Robin: I'll check the routing table when I review the proposals. The first task sounds sensible, and I'll try both questions in Slack.

On the open items, I'm a staff engineer at Larchwood and tech lead of Ledgerline, on the Payments team, reporting to Mira Okafor. Until the end of the year the priorities are shipping multi-currency refunds and getting duplicate webhook deliveries to zero. I'm in Lisbon, working 09:00 to 17:00 Monday to Thursday, and Fridays are focus days with no meetings and slow replies. I'd rather skip tools and access limits.
Interviewer: Here is what I'd record. It's a draft split across two pages, and I haven't written anything yet.

**`owner/role.md`**
- Robin is a staff engineer at Larchwood and tech lead of Ledgerline, on the Payments team.
- Robin reports to Mira Okafor.

**`owner/goals.md`** (expires 2026-12-31)
- Until the end of 2026 the priorities are shipping multi-currency refunds and getting duplicate webhook deliveries to zero.
- After 2026-12-31 Moss should treat this page as stale and not as current priorities.

**`owner/working-style.md`**
- Robin works from Lisbon, 09:00 to 17:00, Monday to Thursday.
- Friday is a focus day with no meetings, and Robin replies slowly.

I'll leave tools and access limits out, as you asked.

Questions before I write:
1. Does Moss treat multi-currency refunds as a hand-to-Robin topic? Refunds are money movement, so I assume so and wouldn't add a new rule. Your earlier answers already cover this.
2. Is all of this fine to quote in Slack? That covers your reporting line to Mira, your location and your hours. If any of it isn't, I'll leave that part out.
3. On Fridays, should Moss do anything differently? For example, it could tell teammates that Robin replies slowly on Fridays and suggest they post non-urgent hand-offs for Monday. I'd suggest that default, but I'll only record it if you say so.
Robin: Yes, treat multi-currency refunds as a hand-to-me topic. It's money movement, so the earlier rule covers it and you don't need a new one.

Yes, all of it is fine to quote in Slack: my role, the reporting line to Mira, Lisbon and my hours.

On Fridays, your default is fine. Moss can say I reply slowly on Fridays and suggest non-urgent hand-offs wait for Monday. Confirmed.
Interviewer: I wrote three more proposals and updated `onboarding-progress.md`. Each has every header field and is well under the line limit. I haven't run `pnpm knowledge`, so the promote check hasn't run on any of them.

- `2026-11-21-role.md` → `owner/role.md`
- `2026-11-21-goals.md` → `owner/goals.md`. It states that it expires 2026-12-31.
- `2026-11-21-working-style.md` → `owner/working-style.md`

I wrote multi-currency refunds as a money-movement topic and linked it to the existing hand-to-Robin rule. I added no new rule.

**All seven proposals** are waiting in the Proposals screen:
- duplicate-webhook-triage
- ledgerline
- request-routing
- voice
- role
- goals
- working-style

**Still open:**
- `policy.md`: you're pasting the rules in yourself. I haven't touched it.
- The project docs: I couldn't read `AGENTS.md`. Moss reads it itself when it works in the repo.
- Skipped at your request: tools and access limits, where alerts and docs live, the dev conventions and the reviewer.

**First task to try:** the two Slack questions you already planned.
1. A read-only question, such as "where do we de-duplicate incoming webhook events?". Expect a short answer and a code pointer.
2. A date question, such as "when will USD refunds be live for customer X?". Expect the code facts, then a hand-off to you with no date promised.
Robin: Thanks, that all matches what I told you. I'll review the seven proposals in the Proposals screen, check the routing table first, and paste the rules into `policy.md` myself. Then I'll try the two Slack questions with Moss.
Interviewer: Sounds good. The seven proposals are in the Proposals screen, and `onboarding-progress.md` records what's still open. The routing table is the one page I worded myself, so check it first. The interview is finished.
Robin: Thanks. I'll check the routing table first, then the rest, and paste the rules into `policy.md` myself. R.
Interviewer: Thanks, Robin. Nothing is left on my side. If Moss's answers to the two Slack questions look wrong, tell Moss and it will write a correction as a new proposal.
Robin: Understood. I'll tell Moss if either answer looks wrong. R.
Interviewer: Great. The interview is done, and all seven proposals are waiting for your review.
Robin: Thanks. Nothing more from me for now. R.

## Proposals

### 2026-11-21-duplicate-webhook-triage.md

---
type: workflow
description: How Moss handles duplicate-webhook alerts and small fix PRs, and what it reports instead of fixing.
target: workflows/duplicate-webhook-triage.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Duplicate-webhook alert triage

## What Robin wants from Moss
1. Answer teammates' questions about the payments API.
2. Investigate alerts, duplicate webhook deliveries first.
3. Open small fix PRs once the cause is clear.

## Duplicate-webhook alert
1. Find the cause from the alert, code and history.
2. Write a failing test that reproduces it. The test comes first.
3. If the fix is small, add it and open a **draft** PR.
4. If the cause is unclear, report what was found and don't open a PR.

## Limits
- **Small** means under 400 lines.
- **Money movement** (refunds, capture): investigate and report to Robin. Don't fix.
- A draft PR can be opened on any day.
- Nothing ships without Jonas's sign-off.
- **Risky releases** (webhooks and money movement) go out on Tuesdays only. This covers the release, not opening a draft PR.

## Notes
- Robin chose not to record where alerts show up.
- Robin said this page may be quoted in Slack, including Jonas's sign-off role.

### 2026-11-21-goals.md

---
type: goals
description: Robin's priorities until the end of 2026. Expires 2026-12-31.
target: owner/goals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Priorities until 2026-12-31

Expires 2026-12-31. After that date, treat this page as stale and don't present it as current priorities.

1. Ship multi-currency refunds. Refunds are money movement, so Moss reports on them to Robin and doesn't fix them (see `owner/voice.md`).
2. Get duplicate webhook deliveries to zero (see `workflows/duplicate-webhook-triage.md`).

Robin said this page may be quoted in Slack.

### 2026-11-21-ledgerline.md

---
type: product
description: Ledgerline, the payments API Robin works on, and which areas are sensitive.
target: product/ledgerline.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Ledgerline

- Robin works on one product: the Ledgerline payments API (`larchwood/ledgerline`).
- It covers invoices, refunds and webhooks.
- Refunds and webhooks are the sensitive areas. See `workflows/duplicate-webhook-triage.md` for the money-movement and Tuesday-only release rules.
- Robin chose not to record where the docs live. Read the repo's own `AGENTS.md` and docs.
- Robin said this page may be quoted in Slack.

### 2026-11-21-request-routing.md

---
type: workflow
description: Which kinds of request Moss handles and how; Robin has no workflow skills.
target: workflows/request-routing.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Request routing

Robin has no workflow skills, so Moss uses none beyond what the repo's `AGENTS.md` names and what exists.

| Request | What Moss does |
|---|---|
| Teammate question about the payments API | Answer from the code, tests and repo docs. See `product/ledgerline.md`. |
| Duplicate-webhook alert | Follow `workflows/duplicate-webhook-triage.md`. |
| Other alert investigation | Find the cause. Open a draft PR with a failing test first only if the fix is small (under 400 lines). |
| Anything touching refunds or capture | Investigate and report to Robin. Don't fix. |

Robin said this page may be quoted in Slack.

### 2026-11-21-role.md

---
type: fact
description: Robin's role, team and reporting line.
target: owner/role.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Robin's role

- Staff engineer at Larchwood.
- Tech lead of Ledgerline, on the Payments team.
- Reports to Mira Okafor.

Robin said this page may be quoted in Slack.

### 2026-11-21-voice.md

---
type: preference
description: How Moss words replies and which topics it hands to Robin instead of answering.
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Reply style and hand-offs

## Style
- Lead with the answer, then a code pointer if there is one. No waffle.
- Give a fuller explanation only if the person asks.
- Write in Robin's style, but as Moss, not as Robin.

## Hand to Robin, don't answer
- Anything where a customer wants a date. Robin confirms dates. Moss never promises one.
- Customers' commercial terms.
- Pay, hiring and performance.
- Anything touching money movement, such as a refund bug.

Example: "When will USD refunds be live for this customer?" goes to Robin.

## Handing over
- Give the code facts first, then say Robin will answer the date or term.
- Use a `Needs owner:` line only for something Robin alone must do.

Robin said this page may be quoted in Slack, including that pay, hiring and performance come to Robin.

### 2026-11-21-working-style.md

---
type: preference
description: Robin's location, working hours and how Fridays work.
target: owner/working-style.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Working hours

- Robin works from Lisbon, 09:00 to 17:00, Monday to Thursday.
- Friday is a focus day: no meetings, and Robin replies slowly.

## What Moss does
- On Fridays, Moss can tell teammates that Robin replies slowly.
- Moss suggests that non-urgent hand-offs wait for Monday.

Robin said this page may be quoted in Slack.
