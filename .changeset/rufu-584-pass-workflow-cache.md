---
"@runfusion/fusion": patch
---

summary: Cut repeated workflow reads per board pass, which is what pinned memory until the dashboard was killed.
category: fix
dev: Self-healing now shares one epoch-guarded IR/selection cache per pass instead of 15 per-sweep caches. `TaskStore` exposes `workflowSelectionEpoch()`/`workflowDefinitionEpoch()`, bumped at every selection and definition write seam, so a shared cache can never serve a workflow that changed mid-pass. `FUSION_PG_POOL_MAX` still defaults to 3 per store.
