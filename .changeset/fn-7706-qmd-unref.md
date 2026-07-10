---
"@runfusion/fusion": patch
---

summary: Background memory-index refresh no longer keeps short-lived CLI/Node processes alive.
category: fix
dev: The default qmd exec path in `packages/core/src/memory-backend.ts` now unrefs the spawned child + stdio (replacing `promisify(execFile)`, whose internal stream buffering silently re-refs the pipes on a deferred tick, with a hand-rolled `spawn()`-based executor) so a fire-and-forget `scheduleQmd*` refresh never blocks a caller's event loop from draining; long-lived callers (e.g. the dashboard server) still see the refresh resolve/reject normally.
