---
"@runfusion/fusion": minor
---

summary: A card waiting on a work-in-progress slot now says which limit bound, how full it was, and who holds the slots.
category: feature
dev: Splits the deferral reason so a scheduler-owned hold→WIP seam parks under `scheduler-owned-seam` while only a real `capacity-exhausted` refusal keeps `capacity`; `task:workflow-run-suspended` gains `capacityGate`/`capacityUsed`/`capacityHeldBy`/`capacityOldestHolderAgeMs` plus `capacityComputeOutcome`/`capacityStoreOutcome`/`capacityAgentGateError`. The same holder forensics ride the durable `sourceMetadata.wipAdmissionStall` episode (a board surface cannot read run-audit) and reach the card face through `TaskStallReason`. `WorkflowWorkItem["waitReason"]` is unchanged — the split is label-layer only. A structural hold is recognized by its `irHash` sentinel BEFORE the reason is compared, because the principal-routing / overlap-wait hold suspends with `reason: "capacity"` and would otherwise report `capacityGate: "unknown"` on a row a `reason=capacity` monitor also counts. Agent rows come from `AgentStore`, not the `TaskStore` the other snapshot inputs come from, so both deferral wirings resolve an agent reader explicitly; without it `schedulerAgentActive` could not be evaluated at all and every enriched row said `capacityAgentGateError: "unavailable"`.
