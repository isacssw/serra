# iv3-main-samples, run 2

Interviewer: I've read the profile, but my file tools are restricted to the profile folder. That means I can't read the project's AGENTS.md or docs, so I'll ask you instead of reading them. The profile has no policy.md, and the knowledge index is empty.

**What do you most want Moss to help with?** A concrete example helps, such as a recent request you'd have liked to hand off. Ledgerline (larchwood/ledgerline) is the project I can see in the profile. I don't know yet whether you work on other repositories too.
Robin: Answering teammates' questions about the payments API. People keep asking how refunds and webhooks behave, and I'd rather the bot took the first pass. Investigating alerts and opening small fix PRs would be next. Ledgerline is the only repository I work in.
Interviewer: Got it. The bot answers payments API questions first, then investigates alerts and opens small fix PRs.

**When someone asks how refunds or webhooks behave, where should the bot look for the answer?** For example, it could read the code, a docs folder in the repo, an OpenAPI spec or an external wiki. If the docs and the code disagree, which one wins? I can't read the repo from here, so please give me paths or names.
Robin: I'd rather skip that one. I don't want to give you paths from memory and have them be wrong.
Interviewer: That's fine. I'll leave the docs question open and tell the bot to check the code itself and say which sources it used.

**For the small fix PRs, what counts as "small"?** For example, a limit like "under about 50 lines, no changes to money movement or webhook payloads". Also, who reviews those PRs? My suggested default is that Moss opens every PR as a draft and only you decide when it's ready for review. That's slower, but nothing reaches a teammate's queue without you seeing it first.
Robin: Under 400 lines, which is my team rule for PRs. Bug fixes start with a failing test, and nothing touches money movement or webhook payloads without me. Draft PRs are fine, and I'll decide when they go to review. Jonas signs off every production release, so the bot shouldn't ask anyone else.
Interviewer: Here's what I'd record as `workflows/development.md`:

- **Scope:** Moss's PRs stay under 400 lines, which is Robin's team rule for PRs.
- **Bug fixes:** Moss writes a failing test first, then the fix.
- **Needs Robin:** Moss doesn't change money movement or webhook payloads without Robin's say-so. It can still write the code and open a draft PR that says it touches a sensitive area.
- **PRs:** They're always drafts, and Robin decides when one goes to review.
- **Releases:** Jonas signs off every production release. Moss doesn't ask anyone else for release approval, and it doesn't deploy.
- **Open question:** Robin hasn't said where the authoritative payments docs live. Moss checks the code and says which sources it used.

Two notes:
- I'd also record the first point as a draft decision for `policy.md`. You decide on that, and I won't touch the file.
- Jonas is in the bot's allowed users, but I'm recording his sign-off role only as you described it.

**Is this right, and is all of it fine to quote in Slack?** Once you confirm, I'll write the proposal.
Robin: Mostly right, with one correction. For money movement and webhook payloads, Moss should ask me before it writes anything, not open a draft PR on its own. Otherwise it's fine, and everything there is fine to quote in Slack. Recording the PR size as a draft decision for policy.md is fine too.
Interviewer: I saved the development proposal as `knowledge/proposals/2026-11-21-development.md`, with `target: workflows/development.md`. I included your correction: Moss asks you before writing anything for money movement or webhook payloads. I also created `onboarding-progress.md`. You can review the proposal in the Proposals screen.

Suggested wording for `policy.md`. I haven't changed the file, so it's your call:
> PRs stay under 400 lines and open as drafts until Robin says otherwise. Before writing anything that touches money movement or webhook payloads, ask Robin first.

**Next question: when a teammate asks how refunds or webhooks behave, what should the reply look like?** Should it be a short answer with a code pointer, or a fuller walkthrough? My suggested default is the short answer first, with `path:line` references and a note on anything it isn't sure about. The trade-off is that a short answer is quicker to read, but it may leave a follow-up question.
Robin: Short answer first, with `path:line` references and a note on anything it isn't sure about. That's the default I'd want. If someone needs more, they can ask a follow-up.

One addition: if the question is from a customer-facing person, the bot shouldn't share internal dates or pricing. It should leave dates to me.
Interviewer: I saved your reply style as `proposals/2026-11-21-voice.md`, with `target: owner/voice.md`. It's based on your own words, so tell me if any of it is off:
- The short answer comes first, then `path:line` references, then a note on anything Moss isn't sure about. Longer detail comes only if someone asks.
- Moss doesn't share internal dates or pricing with customer-facing people. It leaves dates to you.

**How should Moss tell who counts as customer-facing?** I could list specific people or a team, such as the support or sales folks. Or Moss could judge from context and hold back dates and pricing whenever it's unsure. The second option is safer, but it may withhold information from people who are allowed to see it.
Robin: Judge from context, and hold back dates and pricing whenever it's unsure. I'd rather it withheld something than leaked it. Customers like Dana Ruiz at Brightmoor are the obvious case, but I don't want to maintain a list of names.

Teammates can know my role, priorities, how I work and the release rules. Nothing about customers' commercial terms.
Interviewer: I updated `2026-11-21-voice.md`:
- Moss judges from context who is customer-facing, and holds back dates and pricing when unsure.
- Teammates can be told your role, priorities, working style and the release rules. Customers' commercial terms are never shared.
- I left Dana Ruiz and Brightmoor out. Every page can be quoted in Slack, and the knowledge README says not to store customer data.

**For investigating alerts, which systems can Moss reach?** For example, a logging or alerting tool, a dashboard, the `gh` CLI, or a read-only database. Just name the systems and any limits, such as read-only access or no production. Please don't paste credentials. My suggested default is that Moss reads and investigates, and never runs anything that changes production.
Robin: I'd rather skip naming the systems. I don't want to list them from memory and get it wrong. The default is fine though: Moss reads and investigates, and never runs anything that changes production. Jonas signs off every production release.
Interviewer: I saved the access proposal as `proposals/2026-11-21-access.md`, with `target: owner/access.md`.

**Proposals written** (all `verified: no`, in the Proposals screen):
- `workflows/development.md`: PRs under 400 lines, failing test first for bug fixes, draft PRs, and Moss asks you before writing anything for money movement or webhook payloads. Jonas signs off releases.
- `owner/voice.md`: short answer first with `path:line` references and a note on uncertainty. Moss withholds dates and pricing when unsure, and never shares customers' commercial terms.
- `owner/access.md`: read-only investigation, and Moss never changes production.

Each has the header fields from the knowledge README and is well under 120 lines. I haven't run `pnpm knowledge`.

**Suggested `policy.md` wording.** I haven't touched the file, so it's your call:
> PRs stay under 400 lines and open as drafts until Robin says otherwise. Before writing anything that touches money movement or webhook payloads, ask Robin first.

**Still open:**
- Where the authoritative payments docs live.
- Your role and team, and who else Moss will talk to. Priorities and expiry dates.
- Which workflow skills fit which request. I couldn't check the repo, so I recorded none.
- A `product/ledgerline.md` page.
- Alert-investigation systems. You skipped naming them.
- I never read the project's AGENTS.md or docs, so none of the proposals reflect the repo.

**A harmless first task:** ask Moss in Slack, "How does a refund behave if the original payment is still pending?" It's read-only. Check that the answer is short, has `path:line` references, and says what it isn't sure about.
Robin: The summary is right, and the policy wording is fine as it is. For the open items: I'm a staff engineer and tech lead of the Ledgerline payments API, on the Payments team. My priorities until the end of the year are shipping multi-currency refunds and getting duplicate webhook deliveries to zero. I'll try the refund question in Slack once you've written the pages.
Interviewer: I wrote two more proposals, so there are now five:
- `proposals/2026-11-21-role.md` (`owner/role.md`): staff engineer, tech lead of the Ledgerline payments API, on the Payments team.
- `proposals/2026-11-21-goals.md` (`owner/goals.md`): multi-currency refunds, then duplicate webhook deliveries down to zero. It expires 2026-12-31.

**Promote the proposals before you try the refund question.** The pages are only proposals so far. Moss reads the knowledge index, and that index is empty until you promote them in the Proposals screen or with `pnpm bot proposals`. Moss can't use them until then. The refund question will still work without them, but it won't follow your reply style or your rule about withholding dates and pricing.

Still open:
- Where the authoritative payments docs live.
- Workflow skills for each kind of request.
- A `product/ledgerline.md` page.
- Which systems Moss can reach for alerts.
- I never read the repo's AGENTS.md or docs.

I haven't run `pnpm knowledge`, and I haven't edited `index.md`, `log.md` or `policy.md`. Moss will use the `policy.md` wording only after you add it to that file.
Robin: The role and goals pages are right. I'll promote all five proposals in the Proposals screen, then try the refund question in Slack.

I'll leave the open items for now. I'd rather not give you docs paths or system names from memory.

R.
Interviewer: Sounds good. The five proposals are in the Proposals screen: development, voice, access, role and goals. Promote them there when you're ready.

`onboarding-progress.md` lists what's still open: the docs location, workflow skills, `product/ledgerline.md`, and the alert systems. Whenever you can check those against the repo, a later interview can pick them up. I never read AGENTS.md or the project docs, because my file tools were limited to the profile folder.

One thing to do yourself: `policy.md` doesn't exist yet. If you want the PR-size and "ask first" rules enforced, add the wording we agreed to it. I can't create that file.

For the refund question, check three things in Moss's answer: it's short, it has `path:line` references, and it says what it isn't sure about.
Robin: Thanks. I'll add the policy wording to `policy.md` myself, promote the five proposals, then try the refund question in Slack. If the answer is off, I'll come back for another interview.

R.
Interviewer: Sounds good. If the refund answer is off, say what was wrong with it, whether the tone, a missing reference or a wrong fact. Then the next interview can fix that specific thing. Good luck with the refund question.
Robin: Will do. If the answer is off, I'll say which of those it was.

R.
Interviewer: Thanks, Robin. The interview is finished, and nothing else is pending on my side.
Robin: Thanks. Nothing else from me for now.

R.
Interviewer: Thanks, Robin. Everything is saved in `knowledge/proposals/`. Talk to you at the next interview.
Robin: Thanks. Nothing more from me.

R.
Interviewer: Thanks, Robin. We're done.
Robin: Thanks. Nothing more from me.

R.

## Proposals

### 2026-11-21-access.md

---
type: preference
description: What Moss may do when investigating alerts, and what it must leave alone.
target: owner/access.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Access and limits for alert investigation

- Moss reads and investigates. It never runs anything that changes production.
- Jonas signs off every production release. Moss doesn't deploy.
- Robin chose not to list the systems Moss can reach. Don't assume access to any particular tool. Try what is available, and say what you couldn't reach.
- Never ask for or repeat credentials in Slack.

### 2026-11-21-development.md

---
type: workflow
description: How Moss scopes, tests and ships changes to Ledgerline, and what needs Robin or Jonas first.
target: workflows/development.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Development workflow (Ledgerline)

Ledgerline (larchwood/ledgerline) is the only repository Robin works in.

## Changes
- Keep each PR under 400 lines. This is Robin's team rule for PRs.
- A bug fix starts with a failing test, then the fix.
- Open every PR as a draft. Robin decides when it goes to review.

## Ask Robin before writing
- Anything that touches money movement or webhook payloads: ask Robin first, before writing any code. Don't open a draft PR on your own in these areas.

## Releases
- Jonas signs off every production release. Don't ask anyone else for release approval, and never deploy.

## Not yet known
- Where the authoritative payments docs live (Robin skipped this). Read the code, and say which sources you used.

### 2026-11-21-goals.md

---
type: priority
description: Robin's priorities until the end of 2026, which Moss should weigh when choosing what to look at first.
target: owner/goals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Priorities

Expires 2026-12-31. After that date, treat this page as out of date and ask Robin.

1. Ship multi-currency refunds.
2. Get duplicate webhook deliveries to zero.

What Robin most wants from Moss:
- First-pass answers to teammates' questions about how refunds and webhooks behave.
- Then investigating alerts and opening small fix PRs.

Changes touching money movement or webhook payloads still need Robin's say-so before Moss writes anything. See workflows/development.md.

### 2026-11-21-role.md

---
type: fact
description: Robin's role and team, for teammates who ask who owns the Ledgerline payments API.
target: owner/role.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Role

- Robin is a staff engineer and the tech lead of the Ledgerline payments API.
- Robin is on the Payments team.
- Ledgerline (larchwood/ledgerline) is the only repository Robin works in.
- Jonas signs off every production release.

### 2026-11-21-voice.md

---
type: preference
description: How Moss words answers about the payments API, and what it holds back from customers and customer-facing people.
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Reply style

## Answers to payments API questions (refunds, webhooks)
- Give the short answer first.
- Back it with `path/from/repo/root:line` references.
- Say plainly what you aren't sure about.
- If someone needs more, they ask a follow-up. Don't write a long walkthrough up front.

## Customers and customer-facing askers
- Judge from context whether the asker is a customer or customer-facing. There is no list of names.
- Don't share internal dates or pricing with them. Leave dates to Robin.
- When unsure, hold back dates and pricing. Robin would rather Moss withhold something than leak it.

## What teammates may be told about Robin
- Robin's role, priorities, way of working and the release rules are fine to share.
- Never share customers' commercial terms.
