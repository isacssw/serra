# SERRA-95: UI audit (high-end pass)

Audit and research only; no product code changed. Full report with screenshots and mockups: `~/Desktop/serra-ui-audit/index.html`
(captures in `before/`, mockups in `mockups/`, council output in `council/`). Screenshots stay out of the repo.

Council: Claude Opus 5.5 and Gemini 4 Neon (Antigravity, high), independent. Captured from the real app via the QA harness
(`scripts/qa`), seeded profile with 24 knowledge pages, at 1280×820 in dark and light.

## Scores (overall out of 10, worst first)

| Page | Opus | Gemini | Mean |
|---|---:|---:|---:|
| settings-worker | 4.6 | 4.6 | 4.6 |
| settings-bot | 5.2 | 4.9 | 5.1 |
| about-me | 5.4 | 5.3 | 5.3 |
| secrets | 5.3 | 5.5 | 5.4 |
| proposals | 6.0 | 5.0 | 5.5 |
| settings-repositories | 5.6 | 5.5 | 5.5 |
| settings-alerts | 6.0 | 5.4 | 5.7 |
| pages | 6.3 | 5.2 | 5.8 |
| diagnostics | 5.9 | 5.7 | 5.8 |
| knowledge-overview | 5.9 | 6.4 | 6.2 |
| brief | 6.3 | 6.2 | 6.2 |
| jobs-needs-you | 6.4 | 6.3 | 6.3 |
| jobs-running | 6.3 | 6.4 | 6.3 |
| tools | 6.8 | 5.9 | 6.3 |
| settings-appearance | 6.8 | 5.9 | 6.3 |
| settings-people | 6.9 | 6.1 | 6.5 |
| settings-meetings | 6.4 | 6.7 | 6.6 |
| jobs-done | 6.8 | 6.5 | 6.7 |
| knowledge-graph | 7.4 | 6.6 | 7.0 |
| updates | 7.0 | 7.0 | 7.0 |
| setup | 7.1 | 7.5 | 7.3 |
| new-task | 7.8 | 7.1 | 7.4 |
| palette | 7.7 | 7.8 | 7.8 |

Means: Opus 6.34, Gemini 6.07. Target after the build: every page ≥ 9.

## Main problems across pages

- Card-in-card everywhere: settings sections are bordered panels (#121214) holding bordered fields of the same fill, so fields have no depth and pages read as stacks of boxes.
- Six screens use a raw native <select> (Jobs, Proposals, Secrets, Alerts, Agent backend, Diagnostics): system chevron, wrong height, no brand icons. There is no shared Select.
- Field edge is line (#ffffff1a, 1.2:1) outside setup; only setup meets 3:1. Focus is a hard 2px white outline.
- Per-section Save/Reset pairs (up to 5 per page) plus 'Applies after a restart' on the page and on every card: Bot & Slack shows it 5 times.
- Sidebar lists 12 settings items under the 5 knowledge items: the app looks like a settings tool. Settings belong behind one entry with their own grouped sub-nav.
- Content widths drift: Jobs list ~440px, settings ~750px, Graph full width, Proposals/Pages split panes. No shared content grid.
- Disabled primary buttons render as a grey filled block (ink at 50%) that looks broken in dark mode.
- Typography is flat: page title 20/600, section 16/600, everything else 13-14/400-500 with similar greys; no small-caps meta, no tabular numbers.

## Worst pages and main fixes

- **settings-worker** (4.6): Agent picker as brand-icon cards (T3, Claude Code, Codex, ACP…); Model and provider in one row; branch pattern with live preview; T3 path and developer checkout under a closed 'Advanced'.
- **settings-bot** (5.1): One page-level save bar; restart note once, in the bar; Bot id read-only with an Edit… dialog that holds the warning; Service label under 'Advanced'.
- **about-me** (5.3): One title per card, from the page heading; Audience tabs in the header row; drop the '24 private pages' bar (count goes in the tab); Rail becomes one line: '3 pages left out until verified · Review'.
- **secrets** (5.4): Row per token: name, source select, status pill ('Rejected by Slack'), Replace…; Keychain item name in a tooltip.
- **proposals** (5.5): Show the proposed text first, as a diff against the target; Hide empty metadata; one meta line: 'From #eng · Nov 25'; Folder as custom select; actions: Add page (primary), Merge…, Discard (ghost, danger on hover).
- **settings-repositories** (5.5): Table of repositories (name, path, base, GitHub) with edit in a sheet; Main project is the first row with a 'Main' badge.
- **settings-alerts** (5.7): Empty state with one line and 'Add trigger'; no save bar until something changes.
- **pages** (5.8): Row = page name + muted description; mark verified pages with a small check instead; Detail: title, meta line (area · written · used 6×), body, then actions in the header.

## Copy

80 over-wordy strings (34 removed outright); their 894 words become 225. Rules: say it once (applies-when only in the save bar),
labels over sentences, help ≤ 8 words and only for format or consequence, status in 1–3 words, no reassurance or meta copy, empty states = title + one action.

## Dark palette (proposed)

canvas = sidebar `#09090b`; surface-1 `#0f0f11`; surface-2 `#16161a`; overlay `#1c1c21` + shadow; line-subtle `#ffffff0a`, line `#ffffff12`,
line-strong `#ffffff1f`, line-control `#ffffff5c` (3.3:1); ink `#ececef`, muted `#a1a1aa`, faint `#85858f` (≥ 4.6:1 on every surface); accent = ink;
up `#3ecf8e`, warn `#f5a524`, down `#f87171`. Light keeps white canvas and sidebar, line-control `#0000006e` (3:1). Tokens: `mockups/tokens.css`.

Fields 32px, radius 8, line-control edge, ink focus edge + 3px ring; one shared Select with brand icons replaces 6 native selects;
one floating save bar per settings page; settings as one sidebar entry with a grouped sub-nav.

## Build split

- **A Foundation**: styles.css tokens, `ui/*` (Input, new Select, Button, Badge, Page, Table, EmptyState, Dialog), Sidebar, routes headings, SettingsKit save bar. First.
- **B Knowledge**: Overview, Pages, PageBody, About me, Proposals, Graph header (+ their logic and copy). After A tokens.
- **C Jobs + heavy settings**: Jobs, Worker, AgentBackend, Bot & Slack, Repositories, People, Alerts, Secrets, Brief & policy (+ copy). Plugs in A's Select and save bar.
- **D Setup + small pages + final copy sweep**: setup/*, New task, Updates, Diagnostics, Tools, Meetings, Appearance, Palette, Transcript.

Each stream re-runs the capture and the council on its pages; nothing merges below 9.

## Later (not in this pass)

- Running jobs showing the worker's current step needs a new T3 signal.
- Add search/filter and severity filtering inside the Diagnostics Daemon log viewer.
- Add quick batch-approve / batch-verify actions on Proposals and Pages.
- Add a live step/status subtitle on Running jobs (e.g., current tool or branch name) so active work feels alive in the launch video.
- Add keyboard shortcut hints (J/K, ⌘Enter) on Proposals for rapid triage.
