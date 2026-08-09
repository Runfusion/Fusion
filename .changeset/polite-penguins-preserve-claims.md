---
"@runfusion/fusion": patch
---

summary: Keep recommendation-created tasks recoverable across custom and legacy archive lanes.
category: fix
dev: Treats undeclared legacy archive IDs as tombstones and re-homes active rows without cold-storage restore.
