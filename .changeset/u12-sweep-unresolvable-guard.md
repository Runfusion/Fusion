---
"@runfusion/fusion": patch
---

summary: Startup recovery no longer moves a card using another workflow's columns when its own cannot be loaded.
category: fix
dev: `reconcileUndeclaredTaskColumns`'s unresolvable-workflow guard was unreachable — `resolveWorkflowIrById` swallows every failure and returns the default IR, so a card with an unloadable workflow was judged against `builtin:coding` and re-homed to ITS rebound target. The sweep now proves the task's selection resolves to a real definition before moving, checked only for cards already about to move.
