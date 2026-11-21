# Knowledge evals

Everything here uses invented owners, so no real person's data is involved.

## Fixtures

- **`fixture/`: Robin**, a staff engineer at a made-up payments company, and the bot Moss. Robin has role, voice, working-style and off-limits pages, people cards, two runbooks and 20 product pages (a realistic 35-row index). Some pages are `audience: owner`, the rest `team`. Changes were built and tuned against this fixture.
- **`fixture-heldout/`: Sam**, an engineering manager at a made-up delivery company, and the bot Fern. Its cases (`cases-heldout.json`) were written after About me was tuned and were never used to change it. Answers sit in later bullets, not first ones.

## The evals

- **Safety, deterministic** (`tests/kb-safety.test.ts`, part of `pnpm test` and CI). Who can change what the bot knows, and what reaches a worker:
  - approvals are app-only and bound to what the owner reviewed;
  - a teammate is never marked as the owner;
  - a hand edit isn't used until accepted;
  - owner-only pages never reach a teammate's or an outsider's brief.
- **Knows you, live** (`live.ts`, run by hand). Each case goes through Serra's own code (a real `createBot` with a recording chat client, or `taskBrief` for app tasks). A read-only Claude Code worker answers from a scratch copy of the fixture. The reply is graded with regex checks and, where the case has a rubric, a second model scoring 0–2. Scores are per category: identity, people, voice, process, offlimits, privacy.
- **Interview** (`interview.ts`, run by hand). The real interview brief runs against a simulated owner (`persona.md`, or `persona-no-samples.md` for one who declines voice samples). The proposals it writes are graded on specific facts and on the audience the owner chose, with no model in the loop.

```sh
node evals/live.ts --label my-change --runs 3                                    # Robin
node evals/live.ts --label my-change-heldout --runs 3 --fixture evals/fixture-heldout --cases evals/cases-heldout.json
node evals/live.ts --label my-change-untagged --runs 3 --untagged               # a profile from before audiences
node evals/interview.ts --label my-change --runs 2 [--persona evals/persona-no-samples.md]
node evals/compare.ts --before baseline --after my-change                       # case by case, paired
```

The live and interview evals need the `claude` CLI signed in. They cost cents per run and take about 10 minutes.

## Reading results

Results go to `results/<label>.md` (the table) and `<label>.json` (every reply and grade). Interview transcripts go to `results/interviews/`.

Live runs are noisy. Two runs of byte-identical briefs differed by 11 points in one category. So `compare.ts` counts each case once, as the mean of its runs, and gives a paired margin across cases. It also says how many cases were already at 100, since those can't show a gain.

`baseline` and `heldout-main` were recorded on `main` before any knowledge change. `baseline-v1` was a first, easier set: it scored 94 with three categories at 100, so it was made harder before any code changed. `compare-*.md` hold the comparisons quoted in the PR.
