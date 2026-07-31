---
"@runfusion/fusion": patch
---

summary: Archived tasks no longer reappear on boards whose archive lane is renamed.
category: fix
dev: `listTasksModifiedSinceImpl` excluded the literal `archived`; it now excludes the project's resolved archive columns, keeping the literal as the no-resolution fallback.
