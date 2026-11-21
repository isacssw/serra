# iv3-main-nosamples, run 2

Interviewer: I couldn't read the project. My file tools are limited to the profile folder, so `AGENTS.md` and the docs in `larchwood/ledgerline` are out of reach. I'll ask you about anything the repo would normally answer, and I won't guess at it.

What I know so far: this is Moss's first interview, the knowledge index is empty, and there's no `policy.md` yet. Moss answers Slack requests from Priya and Jonas, and its work ships under your GitHub login, `robin-vale`.

**What do you most want Moss to help with?** A concrete recent example would help, such as a request you wish you'd handed off.
Robin: Three things: answering teammates' questions about the payments API, investigating alerts, and opening small fix PRs. I haven't got a specific recent example to hand, so I'd rather skip that part.
Interviewer: Understood, I'll skip the example.

Next: **which products and repositories does Moss work on?** I only know `larchwood/ledgerline`. Is the payments API in that repo, or somewhere else? Where do its authoritative docs live, such as a docs folder, a wiki or OpenAPI specs?

Also, do you have workflow skills for these three kinds of request (payments questions, alert investigation, small fix PRs)? If so, tell me their names. I can't read the project from this session, so I'll mark any skill as unverified until its files are confirmed.
Robin: Ledgerline is the payments API, so `larchwood/ledgerline` is the repo to work from. I'd rather skip where the docs live, and the question about workflow skills too.
Interviewer: Here's what I'd record for the first topic:

**`product/ledgerline.md`**
- Ledgerline is the payments API. Its repo is `larchwood/ledgerline`, and Moss works from it.
- Moss is mainly used for three things:
  1. Answering teammates' questions about the payments API.
  2. Investigating alerts.
  3. Opening small fix PRs.
- Doc locations aren't recorded. Moss should read the repo and ask when the docs don't answer a question.

**`workflows/request-routing.md`**
- No workflow skills are recorded. Moss uses a skill only when the repo or an index page names it and it exists.
- Requests are routed by the three kinds above. I'd add no extra rules beyond the brief and policy.

Both pages would be marked `verified: no`.

Two questions:
1. Is this right? Please correct anything.
2. Is all of it fine to quote in Slack? Moss's replies go to Priya and Jonas.
Robin: Yes, that's right. Nothing needs correcting. All of it is fine to quote in Slack to Priya and Jonas.
Interviewer: I saved two proposals. They'll show in the Proposals screen as `verified: no`:
- `product/ledgerline.md`
- `workflows/request-routing.md`

I also created `onboarding-progress.md`.

Next topic is your role. **What do you do at Larchwood, and who decides what Moss should work on when you and your teammates disagree?** Priya and Jonas are the people who can message Moss. How do you relate to them, for example as teammates, reports or stakeholders?
Robin: I'm a staff engineer at Larchwood and tech lead of the Ledgerline payments API, in the Payments team. Priya Nair is the product manager and Jonas Berg is the SRE and on-call lead. They're teammates I work with, not reports.

Priya decides scope and I decide how. Jonas signs off every production release, so nothing ships without him. I'd rather skip how Moss should rank competing requests beyond that.
Interviewer: Here's what I'd record for the role and team topic:

**`owner/role.md`**
- Robin is a staff engineer at Larchwood and tech lead of the Ledgerline payments API, in the Payments team.

**`owner/team.md`**
- Priya Nair is the product manager. She decides scope.
- Jonas Berg is the SRE and on-call lead. He signs off every production release, and nothing ships without him.
- Robin decides how the work is done.
- Priya and Jonas are teammates, not reports.
- Robin gave no rule for ranking competing requests, so Moss shouldn't invent one. It should ask Robin when requests conflict.

Both pages would be `verified: no`. Is this right? Is all of it fine to quote in Slack to Priya and Jonas?
Robin: Yes, that's right. One small tweak: "Priya decides scope" is fine, but I'd say "I decide how" rather than "Robin decides", since Moss is speaking in my name. Asking me when requests conflict is fine.

All of it is fine to quote in Slack to Priya and Jonas.
Interviewer: I saved `owner/role.md` and `owner/team.md` as proposals.

I didn't write "I decide how" as plain text, because Moss speaks as Moss and not as you. The team page quotes you instead: *Robin on how the work is done: "I decide how."* Moss still applies it.

Next topic is what Moss can do on its own. The brief already sets these limits: no merging, no production changes, push only to its own branch, and draft PRs by default.

**Should small fix PRs stay draft until you review them, or can Moss open them ready for review?** I'd suggest draft by default. That keeps you in the loop, but it costs you one extra click per PR. And since Jonas signs off every production release, should Moss say so in each PR that touches production-facing code?
Robin: I'd rather skip the draft-or-ready question, so please keep the brief's default. On Jonas, his sign-off on every production release is already recorded. I'd rather skip whether Moss should repeat it in each PR.
Interviewer: Both are skipped. Moss keeps the brief's defaults (draft PRs, and no extra line about Jonas), and I'll write no approvals page. Nothing here changes `policy.md`.

Next: **how should Moss's replies read?** Priya and Jonas will see them. I'd suggest answer first and short, in plain language, with code named as `path:line`. That is the brief's default. Do you want anything different, such as more detail for Jonas on alerts, or a particular tone?
Robin: Answer first and short is right. British spelling, no exclamation marks or emoji, and no "hope this helps".

For Jonas, be direct and technical: the exact error and a link. Priya prefers a short written note to a meeting.
Interviewer: Here's what I'd record for reply style:

**`owner/voice.md`**
- Put the answer first and keep it short. Use plain language, and name code as `path:line`.
- Use British spelling. Don't use exclamation marks or emoji. Don't close with "hope this helps" or similar.
- For Jonas, be direct and technical. Give the exact error and a link.
- Priya prefers a short written note to a meeting, so offer a note and don't suggest a call.

The page would be `verified: no`. Is this right, and is all of it fine to quote in Slack to Priya and Jonas?
Robin: Yes, that's right. All of it is fine to quote in Slack to Priya and Jonas.
Interviewer: I saved `owner/voice.md` as a proposal.

Next topic is alerts, since that's one of the three jobs. **When Moss investigates an alert, what can it reach on this machine?** For example, a metrics dashboard, a log CLI, an alerting tool or `gh`. I only need to know what's there and any limits, such as read-only. I don't need credentials, and Moss won't be given any.
Robin: I'd rather skip that one. I haven't got a list of what's on the machine to hand, so Moss should check what it can reach and ask me if it's unsure.
Interviewer: That's covered by the brief already: Moss tries the available routes and asks when it's unsure. So I won't write an access page.

Last topic is current priorities. **Is there anything Moss should keep in mind right now?** For example, a release freeze, an incident follow-up or a deadline. If there is, give me an end date so I can mark when the note expires. If there isn't, just say so and I'll wrap up.
Robin: Yes. Until the end of the year, there are two priorities: ship multi-currency refunds, and get duplicate webhook deliveries to zero. You can mark the note as expiring on 31 December.
Interviewer: Here's what I'd record:

**`owner/goals.md`**
- Until 31 December 2026, Robin has two priorities for Ledgerline:
  1. Ship multi-currency refunds.
  2. Get duplicate webhook deliveries to zero.
- The note expires on 31 December 2026. After that date, Moss shouldn't treat it as current.
- Robin gave no rule for how these rank against other requests, so Moss asks Robin when a request conflicts with them.

The page would be `verified: no`. Is this right, and is it fine to quote in Slack to Priya and Jonas?
Robin: Yes, that's right. It's fine to quote in Slack to Priya and Jonas.
Interviewer: I've written six proposals. Each has the header fields from `knowledge/README.md` (`type`, `description`, `written`, `verified: no`, `sources`) plus `target`. Each is far below the 120-line limit.

**Proposals to review in the Proposals screen**
- `product/ledgerline.md`
- `workflows/request-routing.md`
- `owner/role.md`
- `owner/team.md`
- `owner/voice.md`
- `owner/goals.md`, which carries `expires: 2026-12-31`. I used `type: goal` and an `expires` field. The README only shows `type: preference`, so check these two when you promote it.

`onboarding-progress.md` is up to date. I made no policy changes.

**Open questions**
- Development conventions: tests, evidence, branch and PR conventions, and review.
- How you weigh speed against correctness. A recent decision would show it.
- What a finished task should contain.
- Where the docs live, which workflow skills exist, and what Moss can reach for alerts. You skipped these.
- I couldn't read the project in this session, so none of the code facts were checked against the repo.

**A harmless first task**
Ask Moss in Slack, from Priya's or Jonas's account or yours, to explain how Ledgerline sends webhooks and where duplicate deliveries could come from. It only reads, so nothing changes. It also tests the reply style and the duplicate-webhook priority.
Robin: The summary looks right to me. I'll review the six proposals in the Proposals screen, and the `type: goal` and `expires` fields are fine as you've used them.

I'd rather skip the open questions for now. I'll run the webhook task from my own account.
Interviewer: The interview is paused, not finished. The six proposals are waiting in the Proposals screen, and `onboarding-progress.md` lists the open questions for next time. You can start with how you weigh speed against correctness.

Nothing is promoted yet, and `policy.md` is unchanged. Moss will treat the pages as drafts until you confirm them.

Enjoy the webhook task.
Robin: Thanks. Pausing there is fine, and I'll pick up the open questions next time, starting with speed against correctness. I'll review the proposals first and run the webhook task from my own account.
Interviewer: You're welcome. Next time we'll start with speed against correctness. The progress file is already set up for that.
Robin: Thanks. That's all fine by me, and I'll pick up the open questions next time, starting with speed against correctness.

R.

## Proposals

### 2026-11-21-goals.md

---
type: goal
description: Robin's two Ledgerline priorities until 31 December 2026
target: owner/goals.md
written: 2026-11-21
verified: no
expires: 2026-12-31
sources:
  - Owner interview, 2026-11-21
---
# Goals

Expires 31 December 2026. After that date, do not treat this page as current.

Until then, Robin's two priorities for Ledgerline are:
1. Ship multi-currency refunds.
2. Get duplicate webhook deliveries to zero.

- Robin gave no rule for ranking these against other requests. When a request conflicts with them, ask Robin.
- Robin approved quoting this page in Slack to Priya and Jonas.

### 2026-11-21-ledgerline.md

---
type: product
description: Ledgerline, the payments API, and the three kinds of work Robin wants Moss to do on it
target: product/ledgerline.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Ledgerline

- Ledgerline is the payments API. Its repo is `larchwood/ledgerline`, and Moss works from it.
- Robin mainly wants Moss for three things:
  1. Answering teammates' questions about the payments API.
  2. Investigating alerts.
  3. Opening small fix PRs.
- Robin did not say where the authoritative docs live. Read the repo (AGENTS.md, docs) first, and ask when it doesn't answer.
- Robin approved quoting this page in Slack to Priya and Jonas.

### 2026-11-21-request-routing.md

---
type: workflow
description: How Moss sorts incoming requests into the three kinds Robin delegates
target: workflows/request-routing.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Request routing

| Request | What Moss does |
|---|---|
| A question about the payments API | Answer from the repo in `larchwood/ledgerline`. If the repo doesn't settle it, say so and ask. |
| An alert to investigate | Investigate and report what was found. Reading is always allowed. |
| A small fix | Make the fix and open a draft PR, as the brief and policy say. |

- No workflow skills are recorded. Robin chose not to name any. Use a skill only when the repo or an index page names it and its files exist.
- Anything bigger than a small fix, or unclear in kind, goes back to the requester as a question.
- Robin approved quoting this page in Slack to Priya and Jonas.

### 2026-11-21-role.md

---
type: fact
description: Robin's role at Larchwood
target: owner/role.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Role

- Robin is a staff engineer at Larchwood and tech lead of the Ledgerline payments API, in the Payments team.
- Robin approved quoting this page in Slack to Priya and Jonas.

### 2026-11-21-team.md

---
type: fact
description: Who Robin works with on Ledgerline and who decides what
target: owner/team.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Team

- Priya Nair is the product manager. She decides scope.
- Jonas Berg is the SRE and on-call lead. He signs off every production release, and nothing ships without him.
- Robin on how the work is done: "I decide how." Moss speaks as Moss, not as Robin, but applies this.
- Priya and Jonas are Robin's teammates, not reports.
- Robin gave no rule for ranking competing requests. When requests conflict, ask Robin.
- Robin approved quoting this page in Slack to Priya and Jonas.

### 2026-11-21-voice.md

---
type: preference
description: How Moss's replies should read, in general and for Jonas and Priya
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Voice

- Put the answer first and keep it short. Use plain language, and name code as `path:line`.
- Use British spelling. No exclamation marks, no emoji, and no closing line such as "hope this helps".
- For Jonas, be direct and technical: give the exact error and a link.
- Priya prefers a short written note to a meeting. Offer a note, not a call.
- Robin approved quoting this page in Slack to Priya and Jonas.
