---
"@runfusion/fusion": patch
---

summary: Stop re-dispatching a task whose workflow role pool is unroutable; the hold now waits as intended.
category: fix
dev: Restores the principal-hold cooldown guard in `executeCore` ahead of the graphRouting claim (dropped by the #3317 executor peel, which re-inlined the read inside `executeWorkflowGraph` behind `!opts?.alreadyClaimed` — a flag its only caller always sets). The ladder is now a primitive with one exported writer (`recordPrincipalHoldBackoff`) and one exported reader (`getActivePrincipalHoldCooldown` / `isPrincipalHoldCoolingDown`), and its test-mode zero is read at record time so the cooldown is testable.
