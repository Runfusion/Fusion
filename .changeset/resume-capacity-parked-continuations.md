---
"@runfusion/fusion": patch
---

summary: Fix queued tasks never starting after the board fills up.
category: fix
dev: `resolvePlanningContinuationCandidate` no longer gates on `waitReason === "planning"`. That skip meant a continuation parked by the capacity-suspend path (`waitReason: "capacity"`) or carrying a NULL reason was owned by nobody — skipped by the only drain that dispatches `runnable` task continuations, and passed over by the self-healing reclaim sweep, which by design leaves `runnable` rows to that drain. Cards sat runnable indefinitely with no state change and no audit row while the engine was idle. Dispatch stays admission-gated by `admitPlanningContinuation`, so a capacity-parked card still resumes only when a slot is genuinely free. Also repairs two stale path allowlists in `planning-claim-single-writer.test.ts` (mission stores and `replan-target.ts` moved into subdirectories), which had left that ratchet red on main.
