---
"@runfusion/fusion": patch
---

summary: Prefer older same-priority tasks when scheduling after priority and overlap checks.
category: fix
dev: Hold/release auto-release candidates rank via compareTasksByPriorityThenAgeAndId (priority desc, createdAt ASC, id).
