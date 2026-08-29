---
"@runfusion/fusion": patch
---

summary: Fix workspace task completion when changes land in only one repository.
category: fix
dev: Adds a per-host workspace resolver, resolves before executor workspace branches, normalizes empty configs, and aggregates commit counts across acquired repositories.
