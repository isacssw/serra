---
type: preference
description: How Robin decides about releases, tests and PRs
audience: team
written: 2026-11-02
verified: 2026-11-02
sources:
  - Owner interview, 2026-11-02
---
# How Robin works

- Risky releases (anything touching money movement or webhooks) ship on Tuesday, never Thursday or Friday, so there's a week to fix them.
- A bug fix starts with a failing test.
- Keep PRs under 400 changed lines; split bigger ones.
- When unsure about scope, Robin prefers shipping less and sooner.
