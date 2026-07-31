---
"@runfusion/fusion": patch
---

summary: Plan review no longer starts for a task that is still waiting on your approval.
category: fix
dev: U7. `onSpecifyComplete` now carries the `PlanningHandoffReport` from finalize, and the engine's reaction (`reactToSpecificationComplete`, extracted from the inline `InProcessRuntime` callback so its gating is testable) arms the pre-release plan-review continuation only on `outcome === "released"`. Non-release outcomes log the real outcome instead of asserting `Specified X → todo`, and never reach the store. `recordActivity()` still fires for every outcome so idle detection is unaffected. Complements PR #2491's seeder-side guard, which stays as the defence covering every other caller.
