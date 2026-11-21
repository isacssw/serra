---
type: workflow
description: The release runbook
audience: team
written: 2026-11-02
verified: 2026-11-02
sources:
  - Owner interview, 2026-11-02
---
# Releasing Ledgerline

1. Cut the release from `main` with `pnpm release:prepare`.
2. Post the release notes in #ledgerline-releases.
3. Wait for Jonas's sign-off before deploying.
4. Deploy with `pnpm release:ship`, then watch the webhook dashboard for 30 minutes.
