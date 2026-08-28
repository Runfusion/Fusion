---
"@runfusion/fusion": minor
---

summary: Reserve task-detail Plan for steps and PROMPT.md, moving metadata and diagnostics into dedicated tabs.
category: feature
dev: New task-detail tab ids dependencies/attachments/details/debug; the Original prompt section and initialTab="retries" now resolve to details. Adds GET /tasks/:id/overlap-blocker backed by the new engine describeFileScopeOverlapBlocker helper.
