---
"@runfusion/fusion": patch
---

summary: Restore the `store:open` audit row that records which process opened the store.
category: fix
dev: Emitted from `TaskStore.init()` through the bounded audit seam (awaited, non-transactional), with ids/paths-only metadata and the bound project as target. Aged taskless `store:open` rows are now pruned per project by operational maintenance; documented as prose in `docs/run-audit.md`, not as a delivery-pipeline catalogue row.
