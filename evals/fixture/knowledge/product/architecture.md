---
type: product
description: Ledgerline architecture
audience: team
written: 2026-11-02
verified: 2026-11-02
sources:
  - Owner interview, 2026-11-02
---
# Ledgerline architecture

- Services: api, invoices, refunds, webhooks, ledger. Postgres per service; events over NATS.
- The ledger is append-only.
