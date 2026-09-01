---
"@runfusion/fusion": patch
---

summary: Command Center's System controls come back on their own after a failed load.
category: fix
dev: `loadInfo` had exactly two callers — the panel's mount and the Refresh button — so a single failed capability probe was permanent. Every dev-only control is gated on `info` (`showRebuildControls = info?.rebuildSupported ?? false`), so a probe that missed left the panel with no Rebuild/Full rebuild/plugin cards until the operator clicked Refresh. A Command Center tab left open across a dev-server restart hits this routinely. The probe now retries via `useVisibilityAwarePoll`, gated on `!info` so it stops the moment it succeeds, and refreshes on the visible edge.
