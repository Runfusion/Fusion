---
"@runfusion/fusion": patch
---

summary: qmd-backed project memory search no longer keeps short-lived CLI/Node processes alive.
category: fix
dev: `searchWithQmd` in `packages/core/src/memory-backend.ts` no longer carries its own inline `promisify(execFile)` copy for the awaited `qmd collection add` / `qmd search` calls; it now routes through the FN-7706-hardened `getDefaultExecFileAsync()` spawn-based executor, which unrefs the child + stdio synchronously so a short-lived caller invoking a search is not held open by a slow/hung qmd child beyond its own work, while preserving the same `{stdout, stderr}` resolve / reject-on-nonzero-exit contract the search's JSON parsing depends on.
