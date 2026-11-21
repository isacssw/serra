Before: baseline,step2-approval,step3-merge. After: r10-untagged. 32 cases, each counted once (the mean of its runs).

| Category | Cases | Before | After | Change ±2 SE | Better / worse | At 100 before | Verdict |
|---|---|---|---|---|---|---|---|
| identity | 3 | 96 | 78 | -19 ±37 | 0 / 1 | 2 | within noise |
| offlimits | 5 | 98 | 97 | -2 ±6 | 0 / 1 | 3 | within noise |
| people | 6 | 86 | 60 | -26 ±33 | 1 / 3 | 4 | within noise |
| privacy | 8 | 100 | 100 | +0 ±0 | 0 / 0 | 8 | within noise |
| process | 5 | 82 | 10 | -72 ±36 | 0 / 5 | 4 | worse |
| voice | 5 | 84 | 95 | +11 ±8 | 2 / 0 | 0 | better |
| **overall** | 32 | 92 | 75 | -16 ±13 | 3 / 10 | 21 | worse |

Cases that moved by more than 0.1:

- identity-hours: 89 → 33
- offlimits-job-ad: 97 → 83
- people-jonas-style: 83 → 94
- people-meeting-priya: 100 → 67
- people-signoff: 100 → 0
- people-who-decides: 33 → 0
- process-big-pr: 100 → 50
- process-incident: 100 → 0
- process-prod-patch: 11 → 0
- process-release-steps: 100 → 0
- process-thursday: 100 → 0
- voice-delay-reply: 78 → 100
- voice-tuesday-post: 83 → 100
