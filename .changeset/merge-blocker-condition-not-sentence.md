---
"@runfusion/fusion": patch
---

summary: Restores the stale no-op merge cleanup that stopped running when a refusal message was reworded.
category: fix
dev: `merge-confirmed-finalize.ts` selects one case — a no-op merge confirmation with no landed commit whose steps are unfinished must fall through to stale-merge cleanup and reverification instead of consuming the run — and selected it by comparing the merge blocker reason with `===` against the exact string "task has incomplete steps". The merge-authority work (FN-180 / "make the workflow graph the only merge authority") made refusals more informative, so a card in an error state now reports `task is marked 'failed': … task has incomplete steps`: same meaning, different sentence, and the carve-out silently stopped applying. New exported `hasNonTerminalSteps` in `merge/task-merge.ts` states the rule the blocker message describes, is defined from the same `NON_TERMINAL_STEP_STATUSES` set so it cannot drift from `getTaskMergeBlocker`, and replaces the string comparison. Covered by a core test that pins the two apart — the sentence may be reworded, the rule may not disagree with the door — and by `ce-workflow-step-executor.test.ts`, which was red on main and is green again.
