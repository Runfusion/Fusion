---
"@runfusion/fusion": patch
---

summary: Manual merge hold now applies to shared-branch-group tasks whose group has dissolved.
category: fix
dev: `isLiveSharedBranchGroupMemberIntegration(task, group)` gates the shared-member auto-merge-off exemption on a live (`status: "open"`) branch group; a missing/finalized/abandoned group degrades to the standalone manual-hold path. Threaded through `project-engine.ts allowInReviewMergeProcessing` and the `executor.ts` merge gates. Fixes issue #1980 (FN-7750).
