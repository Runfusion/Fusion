---
"@runfusion/fusion": patch
---

summary: Mission delivery repair now accepts a completed card on boards that rename the done lane.
category: fix
dev: `getTerminalTaskEvidence` tested only `column === "done"`, so a completed card on a renamed board classified as `nonterminal` and `reconcileFeatureDoneWithTerminalTask` threw `TASK_NOT_TERMINAL`. It now takes resolved complete/archived lane sets, supplied by `AsyncMissionStore` from its `taskStore`. The `TerminalTaskEvidence` type's `column` field was widened from the pinned literals to `string`.
