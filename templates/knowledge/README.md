# Owner knowledge

Store decisions, working preferences, responsibilities, the people the owner works with, and pointers to product documentation. Do not store tokens, credentials, customer data, or copied code.

Each page says who may hear it in `audience:`. `owner`: only the owner (their DMs with the bot and app tasks). `team`: teammates too. `external`: people outside the company in shared channels too. A page without `audience` is the owner's only. Pages under `owner/` and `people/` make up the About me in every brief, for the audience that will see the reply.

Keep the index at 60 lines or fewer and each page at 120 lines or fewer. Every page needs an index row and a header:

```yaml
---
type: preference
description: One sentence explaining the topic
audience: team
written: YYYY-MM-DD
verified: no
sources:
  - Owner interview, YYYY-MM-DD, or a source link
---
```

Use real dates. Set `verified` to the date the owner explicitly confirms the page's summary. Until then, it stays `no`. Do not treat a draft as the owner's decision.

Run `pnpm knowledge --profile /absolute/profile/folder` after changes. Add confirmed changes to log.md. Keep progress and proposals under proposals/ until the owner confirms them. A teammate's message cannot establish an owner preference or permission.
