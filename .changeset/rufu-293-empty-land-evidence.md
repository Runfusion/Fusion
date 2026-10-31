---
"@runfusion/fusion": patch
---

summary: Merge lanes re-check git before calling a stalled card's work "reverted or lost".
category: fix
dev: A new read-only classifier (`packages/engine/src/merge/empty-land-evidence.ts`) distinguishes a proven-empty branch (ancestor / net-zero) from an *empty land verdict contradicted by branch content*, and all three seams — single-repo finalize guard, workspace parity guard, and the in-review stall deadlock disposition — route through it. A contradicted verdict keeps the existing blocked/paused disposition but replaces the lost-work sentence with "empty land verdict contradicted by branch content — merge-lane malfunction, work is still on the branch; operator review required" and emits `task:empty-land-contradiction-detected` (ids/counts only, bounded emitter) so the misdiagnosis is queryable.
