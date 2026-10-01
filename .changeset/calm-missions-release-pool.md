---
"@runfusion/fusion": patch
---

summary: Prevent concurrent mission feature claims and duplicate cleanup from exhausting the PostgreSQL pool.
category: fix
dev: Resolves workflow archive lanes before entering feature-claim and duplicate-reconciliation transactions.
