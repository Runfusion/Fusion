---
"@runfusion/fusion": patch
---

summary: Fix built-in workflows sending cards backward to Todo and stalling the PR workflow.
category: fix
dev: Unseamed nodes in linear built-ins (`security` in Review-heavy, `design-review` in Design, `review-handoff`/`document` in Compound Engineering) defaulted to the capacity-hold column, so the graph moved live cards back into Todo mid-run; they now inherit the preceding node's column. Separately, the `hold` node kind had no default handler, so every hold node threw "No handler registered" — Pull Request workflow cards died at `await-review`; holds now park in place like `manual-merge-hold`.
