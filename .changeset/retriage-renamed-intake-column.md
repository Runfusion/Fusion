---
"@runfusion/fusion": patch
---

summary: Fix user comments not invalidating spec approval on Coding (Ideas) cards.
category: fix
dev: `addComment`'s re-triage gate listed the legacy `todo`/`triage` column ids, which miss a workflow with a renamed intake column — `builtin:coding-ideas` uses `ideas`. An operator comment on such a card awaiting spec approval invalidated nothing. The gate now resolves the intake/hold roles from the card's own workflow, only for user comments, falling back to the legacy pair when no workflow resolves.
