# How your knowledge grows

**Knowledge › Overview** shows whether your bot knows you better over time, and what to tidy. Everything on it is worked out on your Mac from files Serra already keeps: your pages, the backup each approval or edit leaves in `backups/knowledge/`, and `logs/knowledge-usage.jsonl`. No model is asked and nothing is sent anywhere.

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

The brief asks the worker to end a reply with one line naming the pages it used. Serra takes that line out before anything is posted and records it, for every T3 provider, since it's plain text in the reply. **Used in replies** shows the share of replies in the last 30 days that used knowledge, the pages used most, and, after ten replies, the pages none used. A task started in the app shows that line in its T3 thread, since Serra doesn't post those replies.

## What the worker sees

- Each index row whose page is a draft or wasn't confirmed in 60 days says so, like `(confirmed 2026-08-01; may be out of date)`.
- A row whose page holds a rule that disagrees with another says `(two rules disagree: see below)`, and below the index the worker gets both rules with their pages' dates: follow the clearly newer one and say the other looks out of date, ask you only when it can't tell. Only pages that reply's audience may hear are compared.
- Under the index, the three pages that look closest to the request, as a hint to open first. It's a word match on each page's path, index row, description, headings and text, not a model.

## How well it works

Measured on invented owners, through Serra's own T3 layer (`evals/kb-live.ts`), on Claude Opus 5.5 and Codex GPT-6.1 Sol:

- On 26 knows-you cases, answers were right with and without the page hint. With the hint, the worker opened a knowledge page more often (90% vs 84% of runs) and opened a hinted page 94% vs 82% of the time: a small gain, from 2 runs.
- When the newer of two rules sat on a page whose index row doesn't match the question, workers with the conflict notes answered with the newer rule every time (8 of 8 runs); without them they said the notes disagree and gave no answer (0 of 8).
- Replies named the pages they used in every answered run, and the named pages were ones the worker had opened or had in About me in 96–100% of runs.

## Checking it

`node evals/kb-health.ts` prints the numbers: how often the hint's top three hold a right page for 60 requests on two invented owners, how often it stays quiet on 8 requests no page helps with, the health of those owners' pages, and six months of an invented owner whose knowledge picks up conflicts, repeats and stale pages and is then tidied, all through Serra's real approval code. `tests/knowledge-health.test.ts` holds the same checks as tests.

`node evals/kb-live.ts [--set messy] [--judge] [--provider <T3 instance> --model <model>]` runs the live comparison through T3 (T3 Code must be running). It costs a few dollars and about 15 minutes per arm set; results go to `evals/results/` (git-ignored).
