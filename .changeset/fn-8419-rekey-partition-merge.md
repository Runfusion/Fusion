---
"@runfusion/fusion": patch
---

summary: Fix startup crash when a project has both fallback and registered partition data.
category: fix
dev: Rekey merges catalog-discovered dual partition conflicts fallback-wins with NULL-correct matching and fail-closed FK checks; startup degrades to fallback data and unique failures stop supervised retry loops.
