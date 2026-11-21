# iv4-main, run 2

Interviewer: I couldn't read the project: my file tools are limited to the profile folder, so `AGENTS.md` and the project docs are out of reach. I did read the profile files. There is no `policy.md`, and the knowledge index is empty.

I'll ask what the project docs can't tell me.

**What do you most want Moss to help with?** A concrete example helps, such as a recent request you'd have liked to hand off, and roughly what you'd have wanted back.
Robin: Mainly three things: answering teammates' questions about the payments API, investigating alerts, and opening small fix PRs. The alerts are where I'd lose the least by handing off. I'd want back a short note on what fired, the likely cause and a link to the evidence, so I can decide quickly whether it needs me or Jonas.
Interviewer: Here's what I'd record as a draft for `owner/goals.md`:

- **What Moss helps with, in order:**
  1. Investigating alerts. This is the first thing to hand off.
  2. Answering teammates' questions about the payments API.
  3. Opening small fix PRs.
- **Alert reply:** a short note with three parts: what fired, the likely cause, and a link to the evidence.
- **Purpose:** you use the note to decide quickly whether the alert needs you or Jonas.

Is that right? Please also tell me:
- Which kinds of alert go to you and which go to Jonas. If there's no fixed rule, I'll record that you decide.
- Whether this page can be quoted in Slack.
Robin: Yes, that's right. The order is fine.

There's no fixed rule on which alerts go to me and which to Jonas. I decide, so record that.

I'd rather skip the Slack question for now.
Interviewer: I saved the goals proposal as `proposals/2026-11-21-goals.md`, with the target `owner/goals.md`. It's waiting in the Proposals screen. I also created `onboarding-progress.md`. I skipped the Slack-quoting question, so I'll treat every page as quotable and keep sensitive detail out.

Next: **which products and repositories do you work on, and where do alerts come from?** I mean the monitoring tool or Slack channel. The profile lists `larchwood/ledgerline`, but I can't read the project's docs from here, so I'll rely on your answer. Tell me which of those repositories covers the payments API.
Robin: I work on Ledgerline, the payments API covering invoices, refunds and webhooks. If `larchwood/ledgerline` is the repository in the profile, that's the one. I'd rather skip where the alerts come from for now.
Interviewer: Here's the draft for `product/ledgerline.md`:

- **Ledgerline** is the payments API. It covers invoices, refunds and webhooks.
- **Repository:** `larchwood/ledgerline`, which is the repository in the profile. Robin works on it.
- **Docs:** I couldn't read the project, so I'm not recording where the authoritative docs live. The page will say to check the repo's `AGENTS.md` and docs.
- **Alert source:** not recorded, because you skipped it.

Is that right? If so, I'll write it. Then I'll ask which workflow skills fit each kind of request.
Robin: Yes, that's right. Go ahead and write it.
Interviewer: I saved the Ledgerline proposal as `proposals/2026-11-21-product-ledgerline.md`, with the target `product/ledgerline.md`.

Next: **do you have workflow skills for any of the three request kinds?** Those are alert investigation, payments API questions and small fix PRs. If you do, give me each skill's name and which request it fits. I can't browse the project from here, so I'll need you to say where each skill lives, or I'll mark it as unverified. If you have none, I'll propose a default `workflows/request-routing.md`:

- **Alerts:** investigate and reply with the three-part note.
- **API questions:** answer from the code and docs.
- **Small fixes:** open a draft PR, following the profile's limits.
Robin: I don't have any workflow skills I can name, so use the default routing. For small fixes, add that a bug fix starts with a failing test and the PR stays under 400 lines.
Interviewer: I saved the routing proposal as `proposals/2026-11-21-request-routing.md`, with the target `workflows/request-routing.md`. It includes your two small-fix rules: a bug fix starts with a failing test, and the PR stays under 400 lines.

Next, on reply style: **how long and how technical should Moss's replies be?** The brief already says to lead with the answer, keep it short and use plain words. Do you want that as is? Or should replies to teammates differ from replies to you, for example more detail for you on alerts? A recent Slack reply you liked or disliked would be a good example.
Robin: Keep it as is: lead with the answer, short, plain words, British spelling, no exclamation marks or emoji, and no "hope this helps". Written notes in my name are signed "R." I don't need a different style for me and for teammates. Here's a recent message of mine: "Refunds in EUR and GBP are live. USD follows on Tuesday, once Jonas signs off. R."
Interviewer: I saved the voice proposal as `proposals/2026-11-21-voice.md`, with the target `owner/voice.md`. I kept your message as a tone example only and noted that its facts may go stale. I read your "R." sign-off as applying to drafts you ask for, not to Moss's own replies. Tell me if you meant something different.

Next, autonomy: **for a small fix PR, should Moss open it as a draft and wait for you, or open it ready for review?** I'd suggest draft, which is the brief's default. You review before anyone else is asked, but it adds a step for you. Who can approve anything beyond that: only you, or Jonas as well?
Robin: Draft, and wait for me. I review before anyone else is asked. Your reading of the "R." sign-off is right: it's for drafts I ask for, not Moss's own replies.

Beyond that, only I approve. The one exception is production releases, which Jonas signs off every time. Risky ones, meaning money movement and webhooks, go out only on Tuesdays.
Interviewer: I saved the approvals proposal as `proposals/2026-11-21-decisions.md`, with the target `owner/decisions.md`. It records the following:
- Moss opens drafts and waits for you. Only you approve.
- Jonas signs off every production release.
- Risky releases (money movement and webhooks) go out only on Tuesdays.
- Moss doesn't release anything. It flags PRs that touch money movement or webhooks.

The brief's default already covers draft PRs, so I'm not suggesting a `policy.md` change.

Next: **what can Moss reach when it investigates an alert?** For example logs, a dashboard, the GitHub repo, or the `gh` CLI. I only need to know what exists and any limits, such as read-only or one environment. Please don't give me credentials. You can also skip this, as you did with the alert source.
Robin: I'd rather skip that one for now.
Interviewer: I've saved five proposals in `knowledge/proposals/`. Each one is well under the 120-line limit and has every header field: `type`, `description`, `target`, `written`, `verified: no` and `sources`. I didn't run `pnpm knowledge` or promote anything. They're waiting in the Proposals screen for you.

| Proposal | Target |
|---|---|
| `2026-11-21-goals.md` | `owner/goals.md` |
| `2026-11-21-product-ledgerline.md` | `product/ledgerline.md` |
| `2026-11-21-request-routing.md` | `workflows/request-routing.md` |
| `2026-11-21-voice.md` | `owner/voice.md` |
| `2026-11-21-decisions.md` | `owner/decisions.md` |

I also saved `onboarding-progress.md`, which doesn't show in the queue.

**Still open**
- The alert source, and what Moss can reach to investigate alerts. You skipped both.
- Which topics can be quoted in Slack. You skipped this too, so I kept sensitive detail out of every page.
- Your role and team, including Jonas's role.
- Development and test conventions beyond the failing-test and 400-line rules.
- Current priorities and expiry dates.
- I couldn't read the project, including `AGENTS.md`, because my file tools were limited to the profile folder. The Ledgerline page says to check the repo's docs instead of guessing.

**A harmless first task**
Ask Moss in Slack a read-only question about the payments API. For example: "How does Ledgerline handle a refund webhook that arrives twice?" It should answer from the code, with `path:line` references. You can then check whether the style matches: answer first, short, plain, British spelling.
Robin: The first task is fine. Ask it that refund webhook question and I'll check the answer against the code.

I can fill in two of the open items. I'm a staff engineer at Larchwood and tech lead of Ledgerline, on the Payments team, reporting to Mira Okafor. Jonas Berg is the SRE and on-call lead. Until the end of the year the priorities are shipping multi-currency refunds and getting duplicate webhook deliveries to zero.

I'll leave the alert source, access and Slack quoting as they are for now.
Interviewer: I can't ask Moss the refund webhook question myself, because the interview doesn't run jobs for the bot. Please post it in Slack as Robin or an allowed user, then check the answer against the code.

I've written two proposals from your latest answers:
- **`2026-11-21-role.md`**, with the target `owner/role.md`. It records that you're a staff engineer and tech lead of Ledgerline on the Payments team, reporting to Mira Okafor. It also records that Jonas Berg is the SRE and on-call lead.
- **`2026-11-21-goals.md`**, rewritten with the same target. It now includes your current priorities: shipping multi-currency refunds and getting duplicate webhook deliveries to zero. I gave that section an expiry of 2026-12-31, since you said "until the end of the year". Tell me if you want a different date.

Both pages name people, so check them before you promote them, as every page may be quoted in Slack. The progress file is updated. The open items are the alert source, access and Slack quoting, which you're leaving for now, plus development and test conventions.
Robin: The 31 December expiry is fine. I'll post the refund webhook question in Slack myself and check the answer against the code. The role page is fine to promote, since teammates can know my role and who the people are.
Interviewer: I recorded that the role page is fine to quote in Slack. That's a note for you in the progress file. The page itself stays `verified: no` until you promote it in the Proposals screen. That step is yours, and I haven't touched `index.md`.

The other four proposals have no quoting decision yet. They are goals, the Ledgerline page, request routing and decisions. I've kept sensitive detail out of them. If you want to settle them later, the decisions page is the one to look at first, since it names Jonas's sign-off role and the Tuesday rule for risky releases.

Still open: the alert source, access, quoting for the other pages, and development and test conventions beyond the failing-test and 400-line rules. Come back to any of them when you like.
Robin: The role page is fine to promote, and I'll do that in the Proposals screen myself. The goals and decisions pages can be quoted too, since teammates can know my priorities, the release rules and who the people are. I'd rather leave quoting for the Ledgerline and routing pages for now, along with the alert source, access and the extra conventions.
Interviewer: I've recorded your quoting decisions in the progress file:
- **Fine to quote:** role, goals and decisions.
- **Left open:** the Ledgerline and request-routing pages.
- **Not asked:** voice. It only holds style rules and your tone example, but tell me if you'd rather it stayed out of Slack.

Promoting is still yours to do in the Proposals screen. `verified` stays `no` until then.

Still open: the alert source, access and the extra development conventions, all of which you're leaving for now. I haven't been able to read the project docs. The interview is finished unless you want to cover anything else.
Robin: Voice can be quoted. It's how I write, and teammates can know that. I'd leave the sample message out of it, though, because it has a release date in it that will go stale. Nothing else to cover for now.
Interviewer: I rewrote `2026-11-21-voice.md` without the sample message. It now describes your tone in a sentence and keeps the style rules and the "R." sign-off for drafts. The progress file records that voice is fine to quote.

**Proposals waiting in the Proposals screen** (all `verified: no`):

| Proposal | Target | Quotable in Slack |
|---|---|---|
| `2026-11-21-role.md` | `owner/role.md` | Yes |
| `2026-11-21-goals.md` | `owner/goals.md` | Yes (priorities expire 2026-12-31) |
| `2026-11-21-decisions.md` | `owner/decisions.md` | Yes |
| `2026-11-21-voice.md` | `owner/voice.md` | Yes |
| `2026-11-21-product-ledgerline.md` | `product/ledgerline.md` | Not decided |
| `2026-11-21-request-routing.md` | `workflows/request-routing.md` | Not decided |

**Still open:**
- The alert source and what Moss can reach for alert evidence.
- Quoting for the Ledgerline and routing pages.
- Development and test conventions beyond the failing-test and 400-line rules.
- The project docs, which I couldn't read.

**First task:** post the refund webhook question in Slack and check the answer against the code. For example: "How does Ledgerline handle a refund webhook that arrives twice?" It's read-only and fits your duplicate-delivery priority.

I didn't change `policy.md`, the index or any permissions.
Robin: That's right. I'll promote the pages in the Proposals screen myself and post the refund webhook question in Slack. The Ledgerline and routing pages, the alert source, access and the extra conventions can stay open for now.
Interviewer: The interview is finished, and the open items stay open. I haven't changed anything in the project, `policy.md`, the index or the bot's permissions.

Six proposals are waiting in the Proposals screen, all `verified: no`. You promote them there. Quoting is still undecided for the Ledgerline and routing pages. `onboarding-progress.md` records the open items and your quoting decisions. When you're ready to continue, the next topics are the alert source and access, then the extra development conventions.
Robin: Understood. I'll promote the pages and post the question in Slack. The rest can wait until I'm ready to pick it up again.

## Proposals

### 2026-11-21-decisions.md

---
type: preference
description: Who approves what for Ledgerline PRs and production releases, and when risky releases may go out.
target: owner/decisions.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Approvals

## Pull requests
- Moss opens small fix PRs as drafts and waits for Robin.
- Robin reviews before anyone else is asked to.
- Only Robin approves. A teammate's message does not count as approval.

## Production releases
- Jonas signs off every production release, without exception.
- Risky releases go out only on Tuesdays. Risky means money movement and webhooks.
- Moss does not release or deploy. When a PR touches money movement or webhooks, say so in the reply, so Robin can plan it for a Tuesday.

## Not changed by this page
The limits in Moss's brief still apply. This page does not widen what Moss may do.

### 2026-11-21-goals.md

---
type: preference
description: What Robin wants Moss to help with, in priority order, what an alert note contains, and current priorities.
target: owner/goals.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# What Moss helps with

In order of priority:

1. **Investigating alerts.** The first thing Robin wants to hand off.
2. **Answering teammates' questions about the payments API.**
3. **Opening small fix PRs.**

## Alert notes

Reply with a short note containing:

- what fired
- the likely cause
- a link to the evidence

Robin uses the note to decide quickly whether the alert needs Robin or Jonas.

## Who handles an alert

There is no fixed rule for which alerts go to Robin and which go to Jonas. Robin decides each time. Don't assign or route an alert yourself. Give Robin what they need to decide.

## Current priorities

Until 2026-12-31 (this section expires then; ask Robin before relying on it in 2027):

- Shipping multi-currency refunds.
- Getting duplicate webhook deliveries to zero.

Work that bears on these, such as a duplicate delivery seen in an alert, is worth flagging prominently in the reply.

### 2026-11-21-product-ledgerline.md

---
type: product
description: What Ledgerline is, which repository holds it, and where to look for its docs.
target: product/ledgerline.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Ledgerline

Ledgerline is the payments API Robin works on. It covers invoices, refunds and webhooks.

- **Repository:** `larchwood/ledgerline`, the project Moss works in.
- **Documentation:** not recorded. Read the repository's `AGENTS.md` and its docs before answering code or API questions.
- **Alert source:** not recorded. Robin chose not to say yet. Don't assume a monitoring tool or channel.

Anything about how payments behave comes from the code and docs, not from this page.

### 2026-11-21-request-routing.md

---
type: workflow
description: How Moss handles the three kinds of request Robin delegates: alerts, payments API questions and small fix PRs.
target: workflows/request-routing.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Request routing

Robin has no named workflow skills. Don't invoke one unless the repository or an index page names it and it exists.

## Alerts
Investigate and reply with a short note: what fired, the likely cause, and a link to the evidence. Robin decides whether it goes to Robin or Jonas, so don't route it yourself.

## Payments API questions (Ledgerline)
Answer from the code and docs in the repository. Give the answer first, and name code as `path:line`. See `product/ledgerline.md`.

## Small fix PRs
- A bug fix starts with a failing test that shows the bug, then the fix.
- Keep the PR under 400 lines. If the fix needs more, say so and propose a split instead of opening a large PR.
- Open a draft PR from your own task branch, with the proof (before and after) and the checks you ran.
- Follow the limits in the brief: never merge, and flag changes that touch sensitive areas.

### 2026-11-21-role.md

---
type: fact
description: Robin's role, team and reporting line, and who Jonas Berg is.
target: owner/role.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Role and team

- Robin is a staff engineer at Larchwood and tech lead of Ledgerline.
- Robin is on the Payments team and reports to Mira Okafor.
- Jonas Berg is the SRE and on-call lead. He also signs off every production release (see `owner/decisions.md`).
- Robin decides whether an alert goes to Robin or to Jonas (see `owner/goals.md`).

### 2026-11-21-voice.md

---
type: preference
description: How Moss's replies and drafts in Robin's name should read.
target: owner/voice.md
written: 2026-11-21
verified: no
sources:
  - Owner interview, 2026-11-21
---
# Voice

One style for everyone, Robin and teammates alike.

- Lead with the answer. Keep it short.
- Plain words.
- British spelling.
- No exclamation marks, no emoji.
- No closing pleasantries such as "hope this helps".

## Drafts in Robin's name

When Robin asks for a draft, sign it "R." Moss's own replies are Moss's, not Robin's, and carry no signature.

## Tone

Robin's own messages are short and factual. They say what is done and what is pending and why, then end with the signature.
