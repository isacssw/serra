# How your knowledge grows

**Knowledge › Overview** is meant to be read in five seconds. It shows one number, how many of the bot's replies used your notes this week (or in the last 30 days before the first review), and under it one real request answered with your notes and without them. **To do** shows only when there is something to do, three items at a time, each one line and one button. Everything else is under **Details**: the weekly review's summary and settings, what each page did, health over time, what the bot knows by area, and what it learned lately.

## The weekly review

Once a week (when the bot replied at least three times that week) Serra looks back at the week's replies:

- **With your notes / Without:** a real request from the week, answered twice from the same notes, once with the page that answered it and once without it, so the only difference is that page. It is shown only where the page clearly helped: not when both answers say the same, when the answer with the page hedges, or when a newer page may have overtaken it.
- What replies said they were missing goes into To do with **Tell it**, which opens a task with "Remember this…" filled in; approve the proposal it writes.

**To do** is the one place to act on your knowledge:

- **Approve** a rewrite that settles rules that disagree or repeat. **See change** shows the page before and after. Serra refuses a rewrite that drops any rule the page had. Approved, the page keeps its own confirmed date, so a rule the review left alone never looks newer than a later page that changed it.
- **Keep Thursday** / **Keep Tuesday** on two rules that disagree (the button names the rule): it saves at once with Undo, and the other rule moves under a dated "Replaced". Pages only points here ("Two rules disagree · Settle"), so a conflict is settled in one place.
- **Retire** a page another one covers, only when that page holds every rule it has (it asks first; Undo brings it back).
- **Still true** for a page not confirmed in 60 days, **Review** for proposals and hand edits, **Tell it** for what replies missed, **Open** for the rest.

**Do all** runs every one-click fix together. A fix done once stays done.

The model part runs as a read-only T3 run in Serra's own empty folder, on the worker's provider and model, the same way meetings run, so it works with any T3 provider. Nothing changes until you approve it. Turn it off with **Every week**, or run it any time with **Run again** (both under Details). Digests are kept in `knowledge-reviews/` in the profile.

## What your notes do

Under Details, every page with what it did in the last 30 days: **Used in N replies** with a request it answered, **Always in the brief** (About me pages, counted apart: their use isn't measured, so they never count as having helped), **Used once**, or **Not used** once there were enough replies to tell, with **Retire** next to it. Pages lists pages by topic, the same areas as Overview, by their descriptions (the file name is on hover; a search box appears once there are more than eight). A page opens as it reads, with **Edit**, **Still true** and **Retire…**; the Markdown and its header only show when you edit. Everything on it is worked out on your Mac from files Serra already keeps: your pages, the backup each approval or edit leaves in `backups/knowledge/`, and `logs/knowledge-usage.jsonl`. No model is asked and nothing is sent anywhere.

## The health score

A score out of 100, made of five parts:

| Part | Weight | What counts |
|---|---|---|
| Recently confirmed | 25% | Pages confirmed in the last 60 days. Drafts and stale pages count against it. |
| No conflicts | 25% | No two current rules that disagree, like "ship on Tuesday" and "ship on Thursday", on one page or two. |
| No repeats | 15% | No rule written on two pages, and no two pages on the same topic. |
| Organised | 20% | Pages have a description, headings and bullets, sit in the index and stay under 90 lines. |
| Areas covered | 15% | Who you are, how you work, how you write, off-limits, people, processes and projects each have a confirmed page. |

**Health over time** rebuilds the score after every change from those backups, plus a point a week, since pages also go stale untouched. A change you undid doesn't count.

## Needs tidying

Each item names its pages and opens them in Pages. The usual fixes:

- **Conflict:** open the page. Pages shows the two rules with **Keep this one**, which moves the other under a dated `## Replaced` heading in your draft; save to keep it. The bot never reads what's under that heading. A rule that says "now" or "since <date>" is marked **Looks newer**.
- **Repeated or same topic:** move what's missing into one page, then **Retire…** the other in Pages. It moves to `knowledge/archive/`, its index row goes, and the toast's **Undo** brings it back.
- **Stale:** read it, then **Mark verified today** and save.

Proposals also says when a new proposal repeats a page you already have, or changes a rule on it ("On the page" / "Proposed"). **Merge into it…** then starts from the page with the old rule swapped for the new one, the old one under `## Replaced`, and anything else the proposal adds kept.

## What replies used

The brief asks the worker to end a reply with one line naming the pages it used, and another naming anything it needed that no page says. Serra takes that line out before anything is posted and records it, for every T3 provider, since it's plain text in the reply. **Used in replies** shows the share of replies in the last 30 days that used knowledge, the pages used most, and, after ten replies, the pages none used. A task started in the app shows that line in its T3 thread, since Serra doesn't post those replies.

## What the worker sees

- Each index row whose page is a draft or wasn't confirmed in 60 days says so, like `(confirmed 2026-08-01; may be out of date)`.
- A row whose page holds a rule that disagrees with another says `(two rules disagree: see below)`, and below the index the worker gets both rules with their pages' dates: follow the clearly newer one and say the other looks out of date, ask you only when it can't tell. A newer rule that says what it ended ("moved from Grafana to Datadog", "OAuth login was removed") is listed the same way, against each older rule that still names it. These pairs are for the worker only: the health score and Settle don't count them. Only pages that reply's audience may hear are compared.
- Under the index, the three pages that look closest to the request, as a hint to open first. It's a word match on each page's path, index row, description, headings and text, not a model.

## How well it works

Measured on invented owners, through Serra's own T3 layer (`evals/kb-live.ts`), on Claude Opus 5.5 and Codex GPT-6.1 Sol:

- On 26 knows-you cases, answers were right with and without the page hint. With the hint, the worker opened a knowledge page more often (90% vs 84% of runs) and opened a hinted page 94% vs 82% of the time: a small gain, from 2 runs.
- When the newer of two rules sat on a page whose index row doesn't match the question, workers with the conflict notes answered with the newer rule every time (8 of 8 runs); without them they said the notes disagree and gave no answer (0 of 8).
- Replies named the pages they used in every answered run, and the named pages were ones the worker had opened or had in About me in 96–100% of runs.

### Before and after

`evals/kb-proof.ts` asks the same 27 questions of an invented owner with 45 pages (rules that changed, a stale page beside a newer one, 15 distractor pages) in three arms: no notes, `main` (ae1a362), and this version. Each question runs 3 times per arm, on Claude Opus 5.5 through T3. Every case and every run is reported, including failures. A run that stops for a tool approval is a harness error and is listed apart; there were none.

| Arm | Pass | 95% interval | Changed rules | Held-out changed rules |
|---|---|---|---|---|
| No notes | 0 of 81 | 0–5% | 0% | 0% |
| `main` | 73 of 81 (90%) | 82–95% | 71% | 93% |
| This version | 81 of 81 (100%) | 95–100% | 100% | 100% |

`main` failed every run of `payload-retention` and `rate-limit` (it gave the older rule), one run of `fx-time` and one of `log-retention`. The five held-out cases were written after the detector was frozen: it flags only 2 of them, and `main` already answered 14 of 15 runs, so most of the gain is on the eight changed-rule cases. To run it again (T3 Code running, `main` checked out at `<main>` with `node_modules` installed):

```
node evals/kb-proof.ts --label proof --runs 3 --before <main> --provider claudeAgent --model claude-opus-5-5 --out <dir> [--resume]
```

It writes `summary.md`, `results.json` and every reply under `none/`, `before/` and `after/`. Eval threads run approval-required, at most three at once, and are settled as soon as their answer is saved; the run ends by settling anything left and reporting the count.

## Checking it

`node evals/kb-health.ts` prints the numbers: how often the hint's top three hold a right page for 60 requests on two invented owners, how often it stays quiet on 8 requests no page helps with, the health of those owners' pages, and six months of an invented owner whose knowledge picks up conflicts, repeats and stale pages and is then tidied, all through Serra's real approval code. `tests/knowledge-health.test.ts` holds the same checks as tests.

`node evals/kb-live.ts [--set messy] [--judge] [--provider <T3 instance> --model <model>]` runs the live comparison through T3 (T3 Code must be running). It costs a few dollars and about 15 minutes per arm set; results go to `evals/results/` (git-ignored).
