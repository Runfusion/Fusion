---
"@runfusion/fusion": patch
---

summary: The duplicate-warning banner in Task Detail now judges the canonical by its own lane, not the legacy ids.
category: fix
dev: `isNearDuplicateCanonicalInactive` in TaskDetailModal now receives `columnFlagsByTaskId.get(canonical.id)`; the allow-list entry claiming this needed a fetch is removed.
