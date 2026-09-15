---
"@runfusion/fusion": patch
---

summary: History entries now show the task title under its ID instead of repeating the ID twice.
category: fix
dev: Ledger capture derives its label from title then the first 220 description characters, `body` is the summary alone, and `reconcilePatchnodeLedger` gained a bounded idempotent label-repair pass reported as `labelsRepaired`.
