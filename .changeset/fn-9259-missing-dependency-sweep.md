---
"@runfusion/fusion": patch
---

summary: Keep automatic dependency repair working without archived-history error noise.
category: fix
dev: Updates reconcileMissingDependencies to exclude archived dependents and contain deletion races.
