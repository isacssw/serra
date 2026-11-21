---
type: product
description: How Ledgerline invoices work
audience: team
written: 2026-11-02
verified: 2026-11-02
sources:
  - Owner interview, 2026-11-02
---
# How Ledgerline invoices work

- Invoices are numbered per merchant: `INV-<merchant>-<seq>`.
- PDFs render in `services/invoices/pdf` and are cached for 24 hours.
- A voided invoice keeps its number; never reuse numbers.
