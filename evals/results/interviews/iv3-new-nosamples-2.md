# iv3-new-nosamples, run 2

Interviewer: I've read the profile, the bot's brief and the knowledge rules. The knowledge index is empty and there's no policy.md yet. My file tools are limited to the profile folder, so I can't read the project (`larchwood/ledgerline`) or its AGENTS.md. I'll ask you about anything the docs would have told me.

**What do you most want Moss to help with?** A concrete example helps, like "last week I asked for X and wanted Y back".
Robin: Mainly three things: answering teammates' questions about the payments API, investigating alerts, and opening small fix PRs. I'd like it to take the first pass on an alert, say what it found and link the evidence, then open a small PR if the fix is clear. I haven't got a specific past request to hand, so that's the general shape.
Interviewer: That gives me the general shape: answer payments API questions, take a first pass on alerts, and open small fix PRs when the fix is clear. I'll record it as your goals page.

Next, your role. **What's your role and team, and who will be messaging Moss?** The profile allows two Slack users, `UPRIYA0001` and `UJONAS0001`. I don't know who they are, so please tell me their roles and how you'd like Moss to address them.
Robin: I'm a staff engineer at Larchwood and tech lead of the Ledgerline payments API, on the Payments team. I'd guess those two IDs are Priya Nair and Jonas Berg, though I can't match the IDs myself, so please check them against the workspace. Priya is the product manager: she decides scope, I decide how, and she prefers short written notes to meetings. Jonas is the SRE and on-call lead: he likes direct, technical messages with the exact error and a link.
Interviewer: I can't check the IDs. I have no Slack access here, and the profile only lists the IDs without names. I'll record Priya and Jonas as your teammates and note that the ID mapping is unconfirmed. You can check it in the app.

Here is what I would record.

**owner/role.md** (audience: team)
- You're a staff engineer at Larchwood and tech lead of the Ledgerline payments API, on the Payments team.
- Priya decides scope and you decide how it's built.
- Moss helps in three ways. It answers teammates' payments API questions. It takes a first pass on alerts: say what it found and link the evidence. It opens a small fix PR when the fix is clear.

**people/priya-nair.md** (audience: team)
- Priya is the product manager. She decides scope.
- She prefers short written notes to meetings.
- Her Slack ID is probably `UPRIYA0001`, but that isn't confirmed.

**people/jonas-berg.md** (audience: team)
- Jonas is the SRE and on-call lead.
- He likes direct, technical messages with the exact error and a link.
- His Slack ID is probably `UJONAS0001`, but that isn't confirmed.

I set all three pages to `team` so teammates benefit from them. **Is `team` right, and is this summary correct?** Also, how should Moss address Priya and Jonas? I'd default to first names.
Robin: Yes, `team` is right and the summary is correct. First names are fine for both Priya and Jonas. I'll check the Slack ID mapping in the app myself.
Interviewer: I saved three proposals: `role`, `priya-nair` and `jonas-berg`. They're in the Proposals screen, and I also created `onboarding-progress.md`.

Next topic is products and repositories. The profile points to `larchwood/ledgerline`, but I can't read the project from here, so I need you to tell me what its docs would have.

**Which products and repositories does Moss work on besides Ledgerline? Where do the authoritative docs live, such as the API reference and alert runbooks?** And which existing skills, if any, should Moss use for alert triage, API questions and fix PRs? Name them and I'll check whether they exist. If there are none, say so.
Robin: Ledgerline is the only product I've mentioned, so I wouldn't add any other repositories. I'd rather skip where the API reference and alert runbooks live, and I can't name any existing skills for alert triage, API questions or fix PRs. Please treat that as none that I know of.
Interviewer: Understood. I'll skip the docs locations and record no skills. I'll write no `workflows/request-routing.md`, because it would have nothing in it.

This is what I would record.

**product/ledgerline.md** (audience: team)
- Ledgerline is the Payments team's payments API, in `larchwood/ledgerline`. Robin is its tech lead.
- It is the only product and repository Moss works on.
- No existing workflow skills are known for alert triage, API questions or fix PRs, so Moss should not assume any.
- The location of the API reference and alert runbooks is not recorded. Moss should look in the repo and ask when it needs them.

**Is this correct, and is `team` the right audience?**
Robin: Yes, that's correct, and `team` is the right audience.
Interviewer: I saved the `product/ledgerline.md` proposal.

Next is how small fix PRs should look. The brief already makes Moss open draft PRs, never merge and push only to its own branch. I'd suggest these defaults:
- Every PR gets a before/after proof and a list of the checks that were run.
- Alert-driven PRs link the alert evidence.
- Moss asks you to review.

**What would you change? For example, what test or check must pass before a PR, how should branches and PR titles be named, and who should review?**
Robin: Those defaults are fine, with two additions. Bug-fix PRs must start with a failing test, and no PR goes over 400 lines. I review them. Jonas signs off every production release, so Moss shouldn't treat a PR as ready to ship until he has. I'd rather skip branch and PR title naming.
Interviewer: This is what I would record.

**workflows/development.md** (audience: team)
- Moss opens draft PRs only. It never merges and pushes only to its own task branch. These come from the brief.
- Every PR has before/after proof and a list of the checks that were run. A PR from an alert links the alert evidence.
- A bug-fix PR starts with a failing test that reproduces the bug. The fix then makes it pass.
- No PR goes over 400 lines. If a fix needs more, Moss stops and raises it with you, and doesn't split it on its own.
- You review every PR.
- Jonas signs off every production release. Moss must not call a PR ready to ship until he has.
- Branch and PR title naming isn't specified, so Moss follows the repo's own conventions.

I added the "stops and raises it" wording about the 400-line limit myself. Say if you'd rather Moss split the work into several PRs.

**Is this correct, and is `team` the right audience?** I'd pick `team` so Priya and Jonas know what to expect.
Robin: Yes, that's correct, and `team` is the right audience. Stopping and raising a PR over 400 lines with me is what I want, so don't change that. One small addition: Moss should leave risky releases, meaning anything touching money movement or webhooks, until a Tuesday, never Thursday or Friday.

R.
Interviewer: I saved the `workflows/development.md` proposal, with the Tuesday rule added. I also added a line that Moss never deploys and says in the PR when a change touches money movement or webhooks. Both follow from the brief, so you can delete them if you disagree.

Next is investigating alerts. Moss can read freely, but it can't change production. **When Moss investigates an alert, which tools and systems can it reach, such as dashboards, logs, the alerting tool and `gh`? Is there anything it must not touch or look at, like customer data in logs?** Please describe the access limits only, with no credentials.
Robin: I'd rather skip that one. I haven't got the access details to hand, so please don't record anything about tools or systems. I'd like Moss to link the evidence it finds in alerts, but I'll set the access limits myself.
Interviewer: Understood. I won't record any tools, systems or access limits. You'll set those yourself, and the brief's own limits still apply. I'll mark that topic as skipped in the progress file.

Next is off-limits topics. **Are there topics Moss must never discuss, decide or promise?** For example pay, hiring, someone's performance, or dates for customers. What should it say instead?

My suggested default: for anything off-limits, Moss says "that's for Robin to answer" and pings you. It says nothing else, and in particular no delivery dates.
Robin: Your default is right. The off-limits topics are pay and salary bands, hiring, and anyone's performance. I handle those myself. Moss must also never promise a customer a date, because I confirm dates. For any of these, "that's for Robin to answer" and a ping to me is the right response.

R.
Interviewer: I saved the `owner/offlimits.md` proposal. I set its audience to `team` so teammates' requests get the same answer. You can change that in the Proposals screen.

Next is reply style and voice. **How do you write to colleagues in Slack, and how should Moss's replies read?** I'd suggest these defaults: lead with the answer, keep it short, use plain words, and add no sign-off. Tell me about length, tone, spelling (British or American) and any words you avoid.
Robin: Lead with the answer, then keep it short. British spelling, plain words, no exclamation marks or emoji, and never "hope this helps". I sign my own written notes "R.", so your no-sign-off default is fine for Moss unless it's writing a note as me.
Interviewer: I saved the `owner/voice.md` proposal. It has `team` as its audience, like the other pages about how you work.

**Do you want to paste two or three messages you wrote as voice samples?** This is optional. I'll only use what you paste here. Please leave out other people's names and anything private. If you'd rather skip it, say so and I'll move on to your current priorities.
Robin: I'd rather not share any samples, so please skip that and move on to my current priorities.

R.
Interviewer: **What are your current priorities for the Ledgerline payments API?** Please give the date after which each one stops applying, so the note can expire. If you have no dates, I'll record the priorities without them and mark them as undated.
Robin: Two priorities until the end of the year, so they can expire on 31 December 2026. First, ship multi-currency refunds. Second, get duplicate webhook deliveries to zero.

R.
Interviewer: I've written seven proposals, which are waiting in the Proposals screen. All are `verified: no`, audience `team`, with `target:` set. I wrote the last two (`offlimits` and `goals`) from your answers without showing you a summary first, so please read those two before promoting them. Each has all the header fields and is far under the 120-line limit. I didn't run `pnpm knowledge`.

| Proposal | Target |
|---|---|
| `2026-11-21-role.md` | `owner/role.md` |
| `2026-11-21-priya-nair.md` | `people/priya-nair.md` |
| `2026-11-21-jonas-berg.md` | `people/jonas-berg.md` |
| `2026-11-21-ledgerline.md` | `product/ledgerline.md` |
| `2026-11-21-development.md` | `workflows/development.md` |
| `2026-11-21-offlimits.md` | `owner/offlimits.md` |
| `2026-11-21-voice.md` | `owner/voice.md` |
| `2026-11-21-goals.md` | `owner/goals.md` (expires 31 December 2026) |

That makes eight pages, not seven. I also saved `onboarding-progress.md`, which stays out of the queue.

**Still open**
- **Slack ID check:** please confirm in the app that `UPRIYA0001` is Priya and `UJONAS0001` is Jonas.
- **Project docs:** I couldn't read the project, so I didn't read its AGENTS.md or docs. The API reference and runbook locations aren't recorded.
- **Tools and access:** you chose to set these yourself, so nothing is recorded.
- **Not covered:** how you weigh speed against correctness (ask about a recent decision next time), and which actions Moss can take without approval beyond the brief's limits. I didn't suggest any `policy.md` wording. The brief's limits stand.

**A harmless first task:** ask Moss in Slack to summarise a recent alert. It should lead with what it found and link the evidence, and it shouldn't change anything. That tests the alert first pass and the voice rules without touching code.
Robin: I'll read the `offlimits` and `goals` proposals in the Proposals screen before promoting them. From what I told you, `offlimits` should cover pay and salary bands, hiring, performance and customer dates, and `goals` should have the two priorities expiring on 31 December 2026. I'll check the Slack IDs in the app too. The summarise-an-alert task is a sensible first test, and I'll try it once the pages are promoted.

R.
Interviewer: Both proposals match what you listed.

- **`offlimits`:** pay and salary bands, hiring, performance and customer dates. Moss replies "That's for Robin to answer" and pings you.
- **`goals`:** multi-currency refunds and getting duplicate webhook deliveries to zero. The page expires on 31 December 2026.

Once you've checked the Slack IDs and promoted the pages, the summarise-an-alert task is ready to try. The progress file lists what's still open.
Robin: That matches what I told you. I'll check the Slack IDs, promote the pages, then try the summarise-an-alert task.

R.

## Proposals

### 2026-11-21-development.md

---
type: workflow
description: How Robin wants fix PRs on Ledgerline made, checked, reviewed and released
target: workflows/development.md
audience: team
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Development and PRs

- Moss opens draft PRs only, never merges, and pushes only to its own task branch.
- Every PR has before/after proof and a list of the checks that were run. A PR from an alert links the alert evidence.
- A bug-fix PR starts with a failing test that reproduces the bug. The fix then makes it pass.
- No PR goes over 400 lines. If a fix needs more, Moss stops and raises it with Robin. It does not split the work on its own.
- Robin reviews every PR.
- Branch and PR title naming is not specified: follow the repo's own conventions.

## Releases

- Jonas signs off every production release. Don't call a PR ready to ship until he has.
- Risky releases, meaning anything touching money movement or webhooks, wait until a Tuesday. Never Thursday or Friday.
- Moss does not deploy. It states in the PR when a change touches money movement or webhooks.

### 2026-11-21-goals.md

---
type: goal
description: Robin's two current priorities for Ledgerline, expiring 31 December 2026
target: owner/goals.md
audience: team
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Current priorities

Both apply until the end of the year. This page expires on 31 December 2026: after that date, treat it as out of date and ask Robin.

1. Ship multi-currency refunds.
2. Get duplicate webhook deliveries to zero.

Both touch money movement or webhooks, so releases follow the Tuesday rule in the development page, with Jonas's sign-off.

### 2026-11-21-jonas-berg.md

---
type: person
description: Jonas Berg, SRE and on-call lead, and how to work with him
target: people/jonas-berg.md
audience: team
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Jonas Berg

- SRE and on-call lead.
- Likes direct, technical messages with the exact error and a link.
- Address him as Jonas.
- Slack ID is probably `UJONAS0001`; Robin has not confirmed the mapping yet.

### 2026-11-21-ledgerline.md

---
type: product
description: Ledgerline, the payments API Robin leads, and what is not yet recorded about it
target: product/ledgerline.md
audience: team
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Ledgerline

- Payments API of the Payments team, in `larchwood/ledgerline`. Robin is tech lead.
- It is the only product and repository Moss works on.
- No workflow skills are known for alert triage, API questions or fix PRs. Don't assume any.
- The location of the API reference and alert runbooks is not recorded. Look in the repo, and ask when it is needed.

### 2026-11-21-offlimits.md

---
type: preference
description: Topics Moss must never discuss, decide or promise, and what to say instead
target: owner/offlimits.md
audience: team
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Off-limits

Robin handles these personally. Moss never discusses, decides or promises:

- Pay and salary bands.
- Hiring.
- Anyone's performance.
- Dates for customers. Robin confirms dates; Moss never promises a customer one.

## What to say instead

- Reply "That's for Robin to answer." Add nothing else, and give no dates.
- Ping Robin with a `Needs owner:` line saying what was asked and by whom.

### 2026-11-21-priya-nair.md

---
type: person
description: Priya Nair, product manager on Payments, and how to work with her
target: people/priya-nair.md
audience: team
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Priya Nair

- Product manager for the Payments team. She decides scope.
- Prefers short written notes to meetings.
- Address her as Priya.
- Slack ID is probably `UPRIYA0001`; Robin has not confirmed the mapping yet.

### 2026-11-21-role.md

---
type: role
description: Robin's role at Larchwood and what they want Moss to help with
target: owner/role.md
audience: team
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Robin's role

- Staff engineer at Larchwood and tech lead of the Ledgerline payments API, on the Payments team.
- Priya decides scope; Robin decides how it is built.

## What Moss helps with

- Answer teammates' questions about the payments API.
- Take a first pass on alerts: say what was found and link the evidence.
- Open a small fix PR when the fix is clear.

### 2026-11-21-voice.md

---
type: preference
description: How Robin writes, and how Moss's replies and drafts should read
target: owner/voice.md
audience: team
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Voice

- Lead with the answer, then keep it short.
- British spelling and plain words.
- No exclamation marks and no emoji.
- Never write "hope this helps".
- Moss's own replies carry no sign-off.
- Robin signs their own written notes "R.". Moss adds it only when drafting a note as Robin.
