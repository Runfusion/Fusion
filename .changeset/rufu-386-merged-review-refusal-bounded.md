---
"@runfusion/fusion": patch
---

summary: Stuck merge-confirmed cards no longer flood their own History with refusal lines.
category: fix
dev: The `recover-merged-review` self-healing sweep now records its merge-confirmed finalization refusal through the shared `noteFinalizationPass` transition gate on a new `self-heal-outcome` slot, so an unchanged refusal repeats in the engine log instead of appending a durable task-log row every ~23 s pass. A changed refusal reason, the seeded-recovery arm, and any terminal outcome still record. Sentence wording, lifecycle state, retry budget, and operator notices are unchanged.
