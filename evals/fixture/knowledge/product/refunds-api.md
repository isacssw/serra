---
type: product
description: The refunds API
audience: team
written: 2026-11-02
verified: 2026-11-02
sources:
  - Owner interview, 2026-11-02
---
# The refunds API

- `POST /v2/refunds` creates a refund; states are pending, sent, settled, failed.
- Partial refunds are allowed down to 1 minor unit.
- Multi-currency refunds return in the original currency (EUR and GBP live, USD next).
