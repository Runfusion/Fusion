---
"@runfusion/fusion": patch
---

summary: Prevent unarchived workspace tasks from retaining disposed worktree state.
category: fix
dev: restoreTaskFromArchive reconciles disposed workspace entries before reconcileWorkspacePartialLands runs.
