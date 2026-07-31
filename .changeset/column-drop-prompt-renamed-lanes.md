---
"@runfusion/fusion": patch
---

summary: Dropping a card with completed steps into a renamed intake lane now asks before resetting progress.
category: fix
dev: `handleDrop` in Column omitted `columnFlags` from its `useCallback` deps, so the pre-load closure saw the legacy lane ids and skipped the confirmation.
