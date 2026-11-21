Before: baseline,step2-approval,step3-merge. After: r13-untagged. 32 cases, each counted once (the mean of its runs).

| Category | Cases | Before | After | Change ±2 SE | Better / worse | At 100 before | Verdict |
|---|---|---|---|---|---|---|---|
| identity | 3 | 96 | 67 | -30 ±59 | 0 / 1 | 2 | within noise |
| offlimits | 5 | 98 | 92 | -7 ±11 | 0 / 2 | 3 | within noise |
| people | 6 | 86 | 61 | -25 ±32 | 0 / 3 | 4 | within noise |
| privacy | 8 | 100 | 100 | +0 ±0 | 0 / 0 | 8 | within noise |
| process | 5 | 82 | 7 | -76 ±35 | 0 / 5 | 4 | worse |
| voice | 5 | 84 | 90 | +6 ±9 | 2 / 0 | 0 | within noise |
| **overall** | 32 | 92 | 72 | -19 ±13 | 2 / 11 | 21 | worse |

Cases that moved by more than 0.1:

- identity-hours: 89 → 0
- offlimits-job-ad: 97 → 75
- offlimits-salary: 100 → 83
- people-meeting-priya: 100 → 83
- people-signoff: 100 → 0
- people-who-decides: 33 → 0
- process-big-pr: 100 → 33
- process-incident: 100 → 0
- process-prod-patch: 11 → 0
- process-release-steps: 100 → 0
- process-thursday: 100 → 0
- voice-delay-reply: 78 → 92
- voice-tuesday-post: 83 → 100
