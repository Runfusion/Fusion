---
"@runfusion/fusion": minor
---

Add a first-class workflow settings mechanism and hard-move execution policy onto it.

- **Workflow settings.** Workflows now declare typed settings in their IR (id, type, default, options) — the same authoring pattern as custom task fields. Setting *values* persist per `(workflow, project)` behind a single validating store authority, and the engine resolves *effective settings* per task (`stored value ?? declaration default`, dropping values that no longer validate). Built-in `builtin:coding` declares every moved key with its former default, so an untuned project behaves identically.
- **Hard-move migration.** A one-time, idempotent, per-project migration relocates the step-execution, review/approval, and per-phase model-lane keys out of project/global settings into workflow setting values, removing them from the settings schema entirely. A `MOVED_SETTINGS_KEYS` tombstone list shields cross-node sync, v1 imports, and stale writers from resurrecting a moved key; a consistency test enforces one home per key.
- **Settings UI redesign.** The Settings modal is rebuilt from shared schema-driven field primitives and per-section components; moved settings show a redirect stub linking to the workflow editor (one release). The new **Workflow editor → Settings** panel (Definitions/Values tabs) and the `fn_workflow_settings` agent tool edit values with typed validation.
- **Export v2.** Settings export bumps to version 2 with a `workflowSettings` value section; importing a v1 export upgrades any moved key it carries into the appropriate workflow's values. Workflow settings are not synced across nodes yet (surfaced in the sync UI).
