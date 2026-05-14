---
"@runfusion/fusion": patch
---

Consolidate ExperimentSessionStore resolution onto
TaskStore.getExperimentSessionStore() across the dashboard experiment
routes, CLI experiment finalize command, and pi-extension tool. Removes
the temporary FN-4218 fallback shim introduced in FN-4222. Behavior
unchanged; single canonical store-resolution path.
