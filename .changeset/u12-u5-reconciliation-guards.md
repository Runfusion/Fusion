---
"@runfusion/fusion": patch
---

summary: Workflow edits, deletes, and switches now reconcile the cards sitting in the affected columns.
category: fix
dev: The three U5 guards (`updateWorkflowDefinition` occupied-column block, `deleteWorkflowDefinition` occupant re-home, `selectTaskWorkflowAndReconcile` switch reconciliation) were gated on the retired raw `experimentalFeatures.workflowColumns` key and had never fired in production. Removing an occupied column now returns a 409 `OccupiedColumnsError` unless `rehomeTo` is supplied; deleting a workflow re-homes its cards immediately rather than at next engine start; switching workflows moves a card whose column the new workflow does not declare and returns a `reconciliation` summary. Also ports the switch path off the synchronous SQLite reader, which throws under PostgreSQL.
