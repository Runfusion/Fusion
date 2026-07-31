---
"@runfusion/fusion": patch
---

summary: Graph-native workflows now reconcile completed task steps after review handoff reaches the merge column.
category: fix
dev: `ensureWorkflowMergeBoundaryTask` evaluates successful node-result proof and projects it onto the legacy checklist before applying its already-at-merge-column no-op. This prevents Compound Engineering tasks from reaching approved review at `0/N`, failing merge with `task has incomplete steps`, and deadlock-pausing.
