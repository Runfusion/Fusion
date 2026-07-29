---
"@runfusion/fusion": patch
---

summary: A task on a workflow with renamed columns can now complete its planning handoff instead of being refused.
category: fix
dev: U7 / R3. `hasAdvancedPastPlanning` compared `task.column === "triage"` literally, so on a renamed workflow a card resting in its OWN intake column fell through to the "steps parsed => advanced" tail and read as advanced. That answer is the predicate handed to `moveTaskIf`/`deleteTaskIf` under the task lock, so a false "advanced" REFUSED the planning handoff outright. The lane is now an injected `PlannerLaneColumns` parameter (not a lookup — these predicates run under the lock, where nothing may await) defaulting to `LEGACY_PLANNER_LANE`, so callers without resolved roles are byte-identical; triage's finalize passes its resolved intake column. Measured: `column === / !== "todo" | "triage"` in replan-target.ts 2 -> 0.
