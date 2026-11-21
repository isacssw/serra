---
type: product
description: How webhooks are delivered
audience: team
written: 2026-11-02
verified: 2026-11-02
sources:
  - Owner interview, 2026-11-02
---
# How webhooks are delivered

- Deliveries retry with exponential backoff for 72 hours.
- Each event has an `idempotency_key`; duplicates come from the retry worker racing the ack.
- The dashboard is the Webhooks board in Grafana.
