---
"@runfusion/fusion": patch
---

summary: AI merge rejections now say why, and a stranded merge can be retried without waiting.
category: fix
dev: Two FN-8004 follow-ups. (1) The review prompt said both "End with a single decision line" and "Then list each concrete reason as a bullet"; reviewers obeyed the former, so reasons landed above the verdict where `extractRejectReasons` never looked, degrading every rejection to "rejected the merge without a stated reason" — which was then fed to the corrective re-merge as its instruction. The parser now recovers reasons from either side of the verdict (inline → after → before, capped at 8) and the prompt ordering is unambiguous. (2) `isStaleMergeActiveStatus` moves to the leaf `merge-active-status.ts`, shared by `SelfHealingManager.recoverStaleMergingStatus` and the dashboard Retry gate, which previously refused every merge-active status; an orphaned `landing` stamp is now retryable by hand while a live merge (holding the lease or refreshing `updatedAt`) is still protected.
