---
"@runfusion/fusion": minor
---

summary: Tasks left mid-flight by an older Fusion are now adopted on upgrade instead of sitting stuck.
category: feature
dev: Migration 0026 adds `workflow_ir_pin`/`workflow_ir_pin_node_id`/`workflow_ir_pin_column_id` (KTD-3 durable per-node-entry IR pin) and `legacy_adopted_at` (KTD-8 one-time adoption stamp); SCHEMA_BASELINE_VERSION 0025 -> 0026. `planLegacyAdoption` is the shared decision run by both new consumers — the `adopt-legacy-task-rows` startup step in self-healing (ordered first, emits `task:reconcile-legacy-adoption` / `-unmappable`) and `adoptLegacyTaskRowsOnOpen` in the backend-mode store open path. Adoption stamps only rows it mutates, never disturbs user pauses or preserve gates, and parks unknown statuses `paused` with the status left visible. `assertBinaryNotOlderThanDatabase` refuses to open a database migrated by a newer binary (numeric comparison, unparseable markers ignored).
