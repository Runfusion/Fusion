---
"@runfusion/fusion": patch
---

summary: A card in a renamed archived lane is now recognised as archived everywhere, not just on two paths.
category: fix
dev: `getLiveTaskColumn` manufactures the sentinel `"archived"` that a dozen comparisons across five files trust, and it tested `row.column === "archived"` — so a live row in a renamed archived lane read as live and every downstream gate opened. It now takes a resolved archived-lane set, threaded from the store-level impls; the shared `resolveArchivedLanes` moved to `project-lane-vocabulary.ts` so there is one answer rather than three copies.
