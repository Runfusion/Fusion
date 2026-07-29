---
"@runfusion/fusion": patch
---

summary: A crashed planner on a workflow with renamed columns is now auto-recovered instead of leaving the task stuck.
category: fix
dev: U7 / R3. Both stale-planning sweeps (`sweepStalePlanningStatuses`, periodic; `clearStaleSpecifyingStatuses`, startup) were gated on the literal pair `triage`/`todo`, so neither fired for a renamed workflow — and `status:"planning"` is itself dispatch-blocking AND makes the card invisible to rediscovery, so those cards had no working repair at all. Both now share one `isInPlanningLane` helper resolving intake/hold from the task's own workflow; an unresolvable workflow answers false (these sweeps mutate, so ignorance must not clear). The startup sweep trades two column-filtered queries for one scan plus a role filter; cheap predicates narrow before any IR is resolved, so only genuine candidates cost a resolution.
