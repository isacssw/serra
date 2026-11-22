<!--
Read CONTRIBUTING.md first. Serra has one maintainer: unsolicited feature PRs are
closed, and following the rules doesn't guarantee a review or a merge.
One problem per PR. The title becomes the commit on main, so it must be a
Conventional Commit: type(scope): subject, lowercase, no trailing period, 72
characters at most, such as "fix(palette): ignore late close events".
Types: feat, fix, perf, refactor, docs, test, build, ci, chore, revert.
Branch: type/short-kebab-description, such as fix/palette-late-close.
See CONTRIBUTING.md › Naming.
-->

## Problem

<!-- The bug in a sentence or two: what you expected, what happened, and how to reproduce it. -->

## Change

<!-- How this fixes it. If it touches several parts (daemon, app, setup, templates), say why the fix needs each. -->

## Scope

<!-- Link the issue that shows the bug. For a small fix of an obvious bug, say why it needs no issue.
If the maintainer asked for this PR, link the request. -->

## Verification

<!-- The tests you added or ran and the manual checks you did (foreground, service or the app), with what you saw.
"Tests pass" alone isn't enough. Say what you couldn't check.
For app changes, upload before and after screenshots here; don't commit them or show a real workspace. -->

- [ ] No real tokens, Slack IDs, names or local paths in code, tests or screenshots
- [ ] README or `docs/` updated if a user would notice the change (`title` checks that a feat or fix adds a `CHANGELOG.md` line)

<!-- If a coding agent did the work, end with the agent and model. -->
