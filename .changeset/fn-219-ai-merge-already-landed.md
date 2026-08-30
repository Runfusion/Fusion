---
"@runfusion/fusion": patch
---

summary: Merger no longer re-runs a full AI merge for work that already landed.
category: fix
dev: runAiMerge short-circuits to finalization when mergeDetails proves a verified landing on the resolved integration branch (confirmed flag, locally present and reachable commitSha, matching mergeTargetBranch, and a pinned landedBranchTipSha equal to the live branch tip); an expected-tip ref deletion fences concurrent branch advances, and any missing or stale proof falls through to the full clean-room merge.
