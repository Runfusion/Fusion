---
"@runfusion/fusion": patch
---

summary: History now describes each delivery with the plan's product summary, not the completion report.
category: fix
dev: Adds `extractPatchnodeProductSummary` to `@fusion/core` (a pure mirror of the dashboard's `extractTaskProductSummary`) and switches `buildPatchnodeEntryInput` to derive `body` from the task plan instead of `task.summary`; every capture site now supplies `PROMPT.md` through the tolerant `readTaskPlanPrompt` helper. The three insertion passes of `reconcilePatchnodeFromLiveTasks` receive an injected plan reader with a per-run memo cache, and a fifth bounded pass repairs existing entries admitted only by the provenance marker `entries.body = tasks.summary`, counted as `productSummariesRepaired`.
