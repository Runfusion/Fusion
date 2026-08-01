---
"@runfusion/fusion": patch
---

summary: Fix worktrees being deleted while a planning agent was still working in them.
category: fix
dev: `clearPhantomExecutorBinding` computed liveness from four TaskExecutor-owned session maps only, so a triage planning session — owned by TriageProcessor and registered in the module-level `activeSessionRegistry` — was invisible to it. Under plan-in-place a card is specified while it sits in `todo`/`triage`, both reapable by `reapLeakedConcurrencySlots`, and planning routinely outlives its 60s grace; every earlier gate passed, so this method decided alone, returned true, released the slot and then unregistered the planner's own registry paths. It now also refuses when `activeSessionRegistry.pathsForTask(taskId)` is non-empty. Being a chokepoint, this covers all three callers (`reapLeakedConcurrencySlots`, `recoverPausedAbortFailures`, and the `preserveWorktrees` reclaim). The 60s grace is deliberately unchanged — a longer timeout would only make the bug rarer.
