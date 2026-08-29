---
"@runfusion/fusion": patch
---

summary: Fix title-only duplicate redirects showing as Ready and workflows created invisible to their own project.
category: fix
dev: Restores the `task.title` argument to `isDuplicateRedirectOnlyPrompt` in `isTaskAwaitingPlanning` (dropped by a refactor after FN-8840) and stamps `layer.projectId` on the `project.workflows` INSERT so FN-8998's project-scoped reads see a bound layer's own create.
