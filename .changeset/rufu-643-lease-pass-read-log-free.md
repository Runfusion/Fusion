---
"@runfusion/fusion": patch
---

summary: The file-scope lease and overlap reconciliation no longer loads the task log it never reads.
category: performance
dev: `excludeLog: true` on the lease pass's whole-board read, after every callee that receives a Task object was body-scanned for log-marker reads (`resolveFileScopeLeaseTaskRoles`, `canClearObservedOverlap`, `recordOverlapRelease` — all zero; the rest are id-only store seams). Behaviour is asserted unchanged, not assumed from helper-level grepping.
