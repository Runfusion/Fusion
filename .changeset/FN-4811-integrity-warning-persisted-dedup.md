---
"@runfusion/fusion": patch
---

fix(FN-4811): persist done-task integrity warnings across engine restarts

`SelfHealingManager.reconcileDoneTaskIntegrity()` previously deduped its
"Integrity warning: done-task finalize evidence is unproven" emissions via an
in-memory `Set<string>` per manager instance. Every engine restart created a
fresh manager, so the periodic sweep re-emitted the same warning for the same
task on every cycle — producing significant log noise on done tasks legitimately
lacking on-main evidence (often FN-4811 contamination residue).

Adds an optional `integrityWarning: { warnedAt, reason }` field on
`MergeDetails` and persists it on the first warning. Subsequent sweeps (within
the same process or after restart) check the persisted reason and skip
re-emitting an identical warning. A different classification reason still
re-warns and updates the persisted record.
