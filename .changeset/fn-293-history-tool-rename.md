---
"@runfusion/fusion": minor
---

summary: Rename the chat delivery-history tool to fn_history_read.
category: feature
dev: Renames `fn_patchnode_read` to `fn_history_read`, `createPatchnodeReadTool` to `createHistoryReadTool`, and `patchnodeReadParams` to `historyReadParams`. The `patchnode` view id, `nav.patchnode` and `patchnode.*` keys, `GET /api/patchnode`, `project.patchnode_entries`, and `@fusion/core` types and methods remain unchanged.
