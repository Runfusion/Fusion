---
"@runfusion/fusion": patch
---

summary: Archive and completion transitions now report the board's own lanes to engine listeners.
category: fix
dev: `archiveTaskBackendImpl` and `moveToDoneImpl` attach `lanes` to their `task:moved` emits, matching `moves.ts`.
