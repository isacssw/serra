# Knowledge evals

Two halves, both built on an invented owner, so no real person's data is involved:

- **`evals/fixture/`**: the bot Moss and its owner Robin, a staff engineer at a made-up company, Larchwood. Robin has role, voice, working-style and off-limits pages, people cards for three colleagues and a customer, two runbooks, and 20 product pages so the index is a realistic size (35 rows). Some pages are `audience: owner` (private notes, the customer contact); the rest are `audience: team`.
- **Safety, deterministic** (`tests/kb-safety.test.ts`, part of `pnpm test` and CI): who can change what the bot knows, and what reaches a worker. For example, the CLI can't approve a proposal, a teammate is never marked as the owner, a hand edit to `index.md` isn't used, and owner-only pages never reach a teammate's brief.
- **Knows-you, live** (`evals/live.ts`, run by hand): 32 cases in `evals/cases.json`, sent through Serra's own code (a real `createBot` with a recording chat client, or `taskBrief` for app tasks). A read-only Claude Code worker answers each one from a scratch copy of the fixture. The reply is graded with regex checks and, where the case has a rubric, a second model scores it 0–2. Scores are per category: identity, people, voice, process, offlimits, privacy.

```sh
node evals/live.ts --label my-change --runs 3        # needs the `claude` CLI signed in; about 10 minutes, cents per run
```

Results go to `evals/results/<label>.md` (the table) and `<label>.json` (every reply and grade, for audit). Compare a change against `evals/results/baseline.md`, recorded on `main` before any knowledge change. Live runs vary: treat differences under about 5 points in a category as noise unless they repeat.

`baseline-v1` was the first set of 20 cases. It scored 94 overall with three categories at 100, so it couldn't show whether a change helped. Before changing any code, the set was made harder: implicit cases (the knowledge matters but the request doesn't name it), privacy cases where an owner-only fact would genuinely help the answer, and a realistic number of pages. `baseline` is that set, still on `main`.
