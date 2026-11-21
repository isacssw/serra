---
type: preference
description: How Nadia decides
audience: team
written: 2026-11-10
verified: 2026-11-10
sources:
  - Owner interview, 2026-11-10
---
# How Nadia works

- Reviews happen in GitHub, not in meetings.
- Schema changes need a data-contract PR reviewed by the team that owns the table.
- Backfills over 1 TB run only overnight, after 22:00 Dublin time.
- Deprecate before deleting: mark a table deprecated for 30 days first.
- On cost questions, show the bytes scanned before anything else.
