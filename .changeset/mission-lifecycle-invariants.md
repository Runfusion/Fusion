---
"@runfusion/fusion": patch
---

summary: Reconcile completed and stale generated-fix mission invariants.
category: fix
dev: Completed missions now normalize autopilot/auto-advance to inactive during autopilot completion, polling, and restart recovery. Mission reconciliation also supersedes generated fix features whose own validator state is already passed, and the scheduler startup sweep runs stale generated-fix reconciliation before trying to relink or retriage active slice features. This prevents complete missions from remaining watched and prevents stale generated fix rows from keeping otherwise-drained missions administratively active.
