---
"@runfusion/fusion": patch
---

summary: Fix Retry refusing cards parked mid-planning on five built-in workflows.
category: fix
dev: The manual retry route decided between specification retry (needs-replan + delete PROMPT.md) and execution retry via `!workflowHasColumn(ir, "triage")`. Measured across all 12 builtins: none plans in `triage`, but seven declare that column, so quick-fix / review-heavy / compound-engineering / design / legacy-coding refused a planning-status card in their own planning column with 400. New `workflowPlansInColumn(ir, column)` asks the graph where planning happens; a card in a pre-WIP column that is not the planning column now takes the non-destructive execution retry rather than losing its spec or its button.
