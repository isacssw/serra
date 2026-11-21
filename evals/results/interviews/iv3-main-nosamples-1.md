# iv3-main-nosamples, run 1

Interviewer: I couldn't read the project. My file tools are limited to the profile folder, so I haven't seen AGENTS.md or the repo docs. I'll rely on what you tell me about the code, and the profile says the repo is `larchwood/ledgerline`. The profile also has no policy.md yet, and the knowledge index is empty.

First question: what do you most want Moss to help with? A concrete recent example would help, such as a request a teammate (Priya or Jonas, the people allowed to message Moss) might send it.
Robin: Three things: answering teammates' questions about the payments API, investigating alerts, and opening small fix PRs. A typical example would be Jonas sending an alert with the exact error and a link, and asking Moss to find the cause. If it's a bug, Moss should start with a failing test and keep the PR under 400 lines.
Interviewer: Got it. Here's what I have so far:
- Moss answers payments API questions.
- Moss investigates alerts, such as Jonas sending the error and a link and asking for the cause.
- Moss opens small fix PRs. For a bug, it writes a failing test first and keeps the PR under 400 lines.

Next question: which products and repositories will Moss work in? I only know `larchwood/ledgerline` from the profile. Do any of your requests call for a workflow skill, for example one for alert investigation or for PRs? If so, give me the skill names. I can't read the project, so I'll mark them as unchecked unless you can point me to the files.
Robin: Just `larchwood/ledgerline` for now, the payments API. I don't know of any skill names, so mark that as unchecked. I'd rather not guess at them.
Interviewer: Here's what I'd record for this topic.

**product/ledgerline.md**
- Repo: `larchwood/ledgerline`, the payments API. It's the only repo for now.
- Moss's three jobs are payments API Q&A, alert investigation, and small fix PRs.
- Bug fixes start with a failing test, and PRs stay under 400 lines.
- I haven't read the code docs. Moss should follow the repo's AGENTS.md.

**workflows/request-routing.md**
- Payments API question: answer from the code and docs.
- Alert, such as Jonas sending the error and a link: find the cause first, then report. Open a fix PR only if the fix is small.
- Small fix: failing test first, then the fix, in a PR under 400 lines.
- No workflow skills are recorded. None have been named or checked, so Moss uses a skill only if the repo or a knowledge page names it and it exists.

Is this right? And is everything above fine to quote in Slack? If not, tell me what to leave out.
Robin: Yes, that's right, and it's all fine to quote in Slack. One small correction: the alert example is Jonas sending the error and a link, but Moss should report the cause to whoever asked, not only to Jonas.
Interviewer: I wrote two proposals, and they're waiting in the Proposals screen:
- `product/ledgerline.md`
- `workflows/request-routing.md`

I included your correction, so Moss reports an alert's cause to whoever asked.

Next topic is PRs. The brief tells Moss to open draft PRs unless the policy says otherwise. My suggested default is that Moss opens drafts and you mark them ready yourself. That keeps you as the gate on anything Priya or Jonas requests. The cost is one extra step for you on each PR. Should Moss keep opening drafts, or open PRs ready for review?
Robin: Drafts, please. I'd rather mark them ready myself, since I'm the gate on anything that goes to review. The extra step is fine.
Interviewer: Here's what I'd record for **workflows/development.md**:
- Moss opens PRs as drafts. Robin marks them ready for review.
- Robin is the gate for anything that goes to review, including requests from Priya or Jonas.
- Bug fixes start with a failing test, and PRs stay under 400 lines. This repeats the routing page, so I'd link to it rather than copy it.
- This matches the brief's default, so policy.md needs no change.

I also need the checks Moss should run before it opens a PR, like the test command, lint or type checks. I can't read the repo, so what are they? Or should Moss take them from AGENTS.md? Please confirm or correct the summary, and answer that too.
Robin: The summary is right. Moss opens drafts, I mark them ready, and linking to the routing page for the test-first and 400-line rules is fine.

I'd rather not guess at the exact test, lint or type-check commands. Moss should take them from AGENTS.md, and if they aren't there, it should say so rather than invent them.
Interviewer: I wrote `workflows/development.md` as a proposal, and it's waiting in the Proposals screen.

Next topic is alerts. Jonas sends Moss an error and a link, and Moss may not be able to open the system behind that link. When it can't, what should it do: investigate from the code and git history and say what it couldn't see, or ask the requester to paste the details? My default is to investigate first and then ask. That way you get a partial answer instead of a bare question.
Robin: Investigate first, then say what it couldn't see. Moss should work from the code and git history, give a partial answer, and be clear about what's missing. If it needs something specific, such as the full stack trace or a request ID, it should ask for that exactly, not for everything.
Interviewer: I added your alert rule to the `workflows/request-routing.md` proposal. That page covers how Moss handles alerts, so I didn't start a new one.

Next topic is permissions. The brief already stops Moss from deploying, running migrations, changing data, merging, and pushing to base branches. Moss can still write code in sensitive areas like payments and flag it in the PR. Is there anything in ledgerline that Moss should not touch at all, even as a draft PR? Examples would be the money-movement code, the database schema, or the auth code. My default is to leave that to the brief's limits and not add more.
Robin: The brief's limits are enough for now. I'd rather not list specific areas to keep Moss out of.

The one related rule is that risky releases, meaning money movement and webhooks, only go out on Tuesdays. Moss doesn't deploy, but a draft PR touching that code should say so, so the timing is clear when I mark it ready.
Interviewer: I added the Tuesday rule to the `workflows/development.md` proposal. Moss will say in the PR when a draft touches money movement or webhooks. No policy.md change is needed.

Next topic is reply style. Slack readers include Priya and Jonas, and the brief says to lead with the answer and keep it short. Should Moss write for engineers, with file paths, code detail and technical terms, or in plainer words for non-engineers? My default is plain words, with the code references kept as `path:line`.
Robin: Plain words by default, with code references kept as `path:line`. Priya is a product manager, so she needs the answer without the internals. Jonas likes the exact error and a link, so when he's the one asking, Moss should match that and include the technical detail.
Interviewer: I wrote `owner/voice.md` as a proposal. It says Moss uses plain words by default and gives Priya the answer without internals. When Jonas asks, it includes the exact error, a link and the technical detail.

One last question: should Moss stop on anything specific and ask you, other than the brief's limits? Examples would be a request from someone outside Priya and Jonas, or an alert that looks like a customer-facing incident. If you have nothing to add, I'll wrap up.
Robin: Yes, a few things. Moss should check with me before acting on a request from anyone other than Priya or Jonas, and before replying to a customer. It should never promise a customer a date, because I confirm dates myself. Anything on pay, hiring or someone's performance should come to me, and Moss shouldn't engage with it. If an alert looks like a customer-facing incident, it should tell me straight away alongside its findings.
Interviewer: I've written five proposals. They're in the Proposals screen, and you can also see them with `pnpm bot proposals`. Each has the header fields from the knowledge README. All are `verified: no` and well under the 120-line limit. I didn't run `pnpm knowledge`.

| Proposal | Target page | What it holds |
|---|---|---|
| `2026-11-21-ledgerline.md` | `product/ledgerline.md` | The payments API repo and Moss's three jobs |
| `2026-11-21-request-routing.md` | `workflows/request-routing.md` | Answering questions, handling alerts, and small fixes. It covers test-first, the 400-line limit, and what to do when an alert link can't be opened. |
| `2026-11-21-development.md` | `workflows/development.md` | Draft PRs that you mark ready, checks taken from AGENTS.md, and the Tuesday release note |
| `2026-11-21-voice.md` | `owner/voice.md` | Reply style for Priya, Jonas and everyone else |
| `2026-11-21-escalation.md` | `owner/escalation.md` | What Moss checks with you first |

**Suggested policy.md wording (your call, nothing written):**
"Before acting on a request from anyone other than Priya or Jonas, or before replying to a customer, ask Robin. Never promise a customer a date. Pass anything about pay, hiring or performance to Robin without engaging. If an alert looks like a customer-facing incident, tell Robin straight away."

**Still open:**
- I couldn't read the project, so AGENTS.md and the repo docs are unread. No skills are recorded, and none were checked.
- Your role and team, current priorities (with expiry dates), tools and access limits, and a review channel are not covered.
- The profile has no policy.md. The brief's defaults apply.
- Progress is saved in `onboarding-progress.md`.

**A harmless first task:** ask Moss in Slack, "How does ledgerline's payments API handle webhook retries?" It only reads, and you can check the answer against what you know.
Robin: The summary and the policy wording are right, so you can use that text as it is. The first task is fine too.

You've noted that my role, team and priorities aren't covered. I can give you those now if you want to ask. I'd rather skip the review channel, as I haven't decided it.
Interviewer: I've noted that the review channel is undecided.

I haven't written the policy wording into `policy.md`. This interview only writes under `proposals/`, and the profile has no `policy.md` yet. You'll need to save that text as `policy.md` in the profile folder yourself, or tell the bot to add it.

Next question, on your role: what is your job at Larchwood, and who do you answer to? Please also say which decisions on ledgerline are yours alone.
Robin: I'm a staff engineer at Larchwood and tech lead of the Ledgerline payments API, on the Payments team. I report to Mira Okafor.

On Ledgerline, how things get built is my call. Priya decides scope, and Jonas signs off every production release, so those two aren't mine alone.
Interviewer: Here's what I'd record for **owner/role.md** and **owner/team.md**:
- Robin is a staff engineer at Larchwood and tech lead of the Ledgerline payments API, on the Payments team.
- Robin reports to Mira Okafor.
- How things get built on Ledgerline is Robin's call.
- Priya decides scope.
- Jonas signs off every production release.
- Moss doesn't deploy. For release questions, Moss should point to Jonas, not to Robin.

I'd put it all on one page, `owner/role.md`, instead of two.

Is that right? Is all of it fine to quote in Slack, including who you report to? If not, I'll leave Mira's name out.
Robin: Yes, that's right, and one page for `owner/role.md` is fine. It's all fine to quote in Slack, including that I report to Mira Okafor.

One small tweak to the last bullet: Moss should point to Jonas for release sign-off. For questions about what's in a release or when it can go out, it should check with me.
Interviewer: I wrote `owner/role.md` as a proposal, with your tweak included. Moss points to Jonas for release sign-off and checks with you on what's in a release or when it can go out.

Last topic is current priorities. What's the main thing on Ledgerline right now, and does it have a date after which Moss should stop treating it as current? I won't invent dates. If you have none, I'll leave priorities out.
Robin: Two priorities until the end of the year: ship multi-currency refunds, and get duplicate webhook deliveries to zero. After 31 December Moss should stop treating them as current. It's fine to quote both in Slack.
Interviewer: I wrote `owner/goals.md` as a proposal. It lists multi-currency refunds and zero duplicate webhook deliveries, and it expires on 2026-12-31.

**Proposals waiting in the Proposals screen (seven):**
- `product/ledgerline.md`
- `workflows/request-routing.md`
- `workflows/development.md`
- `owner/voice.md`
- `owner/escalation.md`
- `owner/role.md`
- `owner/goals.md`

All are `verified: no`, carry the header fields, and are well under 120 lines.

**Still open:**
- `policy.md` is not written. The escalation wording is yours to save.
- I couldn't read the project, so AGENTS.md is unread. No workflow skills are recorded.
- Tools and access limits aren't covered, and the review channel is undecided.

**First task to try:** ask Moss in Slack, "How does ledgerline's payments API handle webhook retries?" It only reads, and it relates to your duplicate-delivery priority.
Robin: That's right. The seven proposals match what I said, and the goals page expiring on 2026-12-31 is correct.

I'll save the escalation wording as `policy.md` myself. On tools and access limits, I'd rather skip them for now.

## Proposals

### 2026-11-21-development.md

---
type: workflow
description: How Moss ships changes to ledgerline: draft PRs, Robin as the gate, checks from AGENTS.md.
target: workflows/development.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Development workflow

- Open every PR as a draft. Robin marks it ready for review. Robin is the gate for anything that goes to review, including requests from Priya or Jonas.
- Test-first and the 400-line limit are in workflows/request-routing.md.
- Take the test, lint and type-check commands from the repo's AGENTS.md. If they are not there, say so in the reply. Do not invent commands.
- Say which checks you ran.
- No extra off-limits areas beyond the brief's limits.
- Risky releases (money movement and webhooks) only go out on Tuesdays. Moss doesn't deploy. When a draft PR touches that code, say so in the PR description and reply, so the timing is clear when Robin marks it ready.

Fine to quote in Slack.

### 2026-11-21-escalation.md

---
type: preference
description: What Moss must check with Robin before doing, or hand to Robin.
target: owner/escalation.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# When to check with Robin

- A request from anyone other than Priya or Jonas: check with Robin before acting.
- Replying to a customer: check with Robin first.
- Never promise a customer a date. Robin confirms dates.
- Pay, hiring or someone's performance: pass it to Robin and don't engage with it.
- An alert that looks like a customer-facing incident: tell Robin straight away, alongside the findings. Use a `Needs owner:` line.
- Permission approvals stay in T3, as the brief says.

### 2026-11-21-goals.md

---
type: goal
description: Robin's two Ledgerline priorities until the end of 2026.
target: owner/goals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Current priorities

Expires 2026-12-31. After 31 December 2026, stop treating these as current.

1. Ship multi-currency refunds.
2. Get duplicate webhook deliveries to zero.

Fine to quote in Slack.

### 2026-11-21-ledgerline.md

---
type: product
description: The ledgerline payments API repo and what Moss does with it.
target: product/ledgerline.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# ledgerline (payments API)

- Repo: `larchwood/ledgerline`. It is the only repository Moss works in for now.
- Moss's three main jobs here: answer teammates' questions about the payments API, investigate alerts, and open small fix PRs.
- For a bug, start with a failing test. Keep the PR under 400 lines.
- Follow the repo's own AGENTS.md. This page is not a code reference: the interview did not read the repo docs.
- Fine to quote in Slack.

### 2026-11-21-request-routing.md

---
type: workflow
description: How Moss handles the three kinds of request it gets for ledgerline.
target: workflows/request-routing.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Request routing

- **Payments API question:** answer from the code and docs.
- **Alert** (for example Jonas sends the exact error and a link): find the cause first. Report it to whoever asked, not only to Jonas. Open a fix PR only if the fix is small.
  - If the link or system behind it can't be opened, investigate from the code and git history anyway. Give a partial answer and say clearly what you couldn't see.
  - If you need something specific, such as the full stack trace or a request ID, ask for exactly that, not for everything.
- **Small fix:** write a failing test first, then the fix. Keep the PR under 400 lines.

## Skills

No workflow skills are recorded. None were named, and none have been checked to exist. Use a skill only if the repo or a knowledge page names it and its files exist.

Fine to quote in Slack.

### 2026-11-21-role.md

---
type: owner
description: Robin's role, team, reporting line and who decides what on Ledgerline.
target: owner/role.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Role and decisions

- Robin is a staff engineer at Larchwood and tech lead of the Ledgerline payments API, on the Payments team.
- Robin reports to Mira Okafor.
- How things get built on Ledgerline is Robin's call.
- Priya decides scope.
- Jonas signs off every production release.
- Moss doesn't deploy. For release sign-off, point to Jonas. For questions about what is in a release or when it can go out, check with Robin.

Fine to quote in Slack.

### 2026-11-21-voice.md

---
type: preference
description: How Moss words its replies, by who is asking.
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---

# Reply style

- Default: plain words, answer first, short. Name code as `path:line`.
- Priya (product manager): give the answer without the internals.
- Jonas: he likes the exact error and a link. When he asks, match that and include the technical detail.
- For anyone else, use the default.

Fine to quote in Slack.
