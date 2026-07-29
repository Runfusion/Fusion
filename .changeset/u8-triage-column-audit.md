---
"@runfusion/fusion": patch
---

summary: Fix a card parked in a non-existent column after a dependency abort, and restore usage-limit pausing while planning.
category: fix
dev: P0 audit after the Planning-column merge removed `triage` from the default lineage. `handleDepAbortCleanup` wrote the literal `triage` (undeclared column; only a restart-time reconcile could rescue the card) and now uses `resolveReboundColumnFor`. `UsageLimitPauser.taskUsesProvider` identified the planning lane by `column === "triage"`, which stopped matching for default cards, so the provider fan-out skipped them; it now matches any pre-implementation column.
