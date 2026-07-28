---
"@runfusion/fusion": patch
---

summary: Fix cards stranding in Planning after Plan Review asks for changes.
category: fix
dev: `hasAdvancedPastPlanning` treated a rebounded replan card as already-advanced once triage claimed it. Plan Review REVISE rebounds to the planner column with `needs-replan` (a durable park), but triage's claim overwrites that with the TRANSIENT `planning`, which is excluded from `REPLAN_PARK_STATUSES` — so the card fell through to the execution timestamps, which are set on the first pass and never cleared. Every guarded planner write then silently no-opped and the finalize never handed the card off. The stamps are now discriminated by arrival order: a stamp predating `columnMovedAt` belongs to a previous pass, while one written after arrival still means execution won the FN-8361 race. The PR #2360 stranded-advanced class (stamps, no planning status) is unchanged. Also logs a warning when a planning finalize declines to hand off, which is how this strand stayed invisible.
