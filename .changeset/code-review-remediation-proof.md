---
"@runfusion/fusion": patch
---

summary: A rejected code review is proven to produce named fix-it steps that run and merge.
category: internal
dev: Adds `pipeline-remediation.pipeline.test.ts`, a dedicated turn-by-turn drive asserting that a Code Review REVISE appends a step carrying `remediation` metadata, that no step is left pending, and that the card reaches `mergeDetails.mergeConfirmed`. It is deliberately separate from S05, which asserts a different property (no merge without a current approval) and reaches it by racing the background auto-merge — the source of that scenario's intermittency. Also reverts the `workflow-graph-foreach` pinned-count relaxation: with it removed the full lane passes 89/89 including this drive, so the engine change was unjustified.
