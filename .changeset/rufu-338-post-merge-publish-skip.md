---
"@runfusion/fusion": patch
---

summary: A merge that skips publishing now says why on the card and in run-audit history.
category: fix
dev: New run-audit event `task:merge-publish-policy-skipped` (`taskId`, `lane` single-repo|workspace, `reasonCode` setting-disabled|merge-strategy-suppressed) plus one task-log line on the direct lane, emitted from a single seam shared by both merge lanes; `isPushAfterMergeEnabled` is now a derivation over the new `explainPushAfterMergeDecision`. No new setting, no `pushAfterMerge` default change, and a withheld publish still writes no `push:origin` transport row.
