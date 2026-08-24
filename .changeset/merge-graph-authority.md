---
"@runfusion/fusion": patch
---

summary: Auto-merge no longer merges a task before its workflow's code review has finished.
category: fix
dev: Every merge door — the in-review sweep, the 300ms column-entry handoff, the unpause re-enqueue, and the pre-dispatch check — is demoted from merge initiator to recovery servicer. `classifyMergeSweepAdmission` (core) admits a card only when it is merge-confirmed, parked at a merge-region node, recovering an interrupted attempt, or long-quiescent; a foreign live session always defers, and every initiation is fenced on satisfied pre-merge gates. Sweep reads are batched (`listWorkflowWorkItemsForTasks`, `getMergeRequestRecordsAsync`) so admission costs O(1) queries per poll rather than O(cards). Workspace and shared-branch-group cards resolve through the same rules — `branch-group-*` nodes are merge-region, and an in-flight sub-repo land reads as live.
