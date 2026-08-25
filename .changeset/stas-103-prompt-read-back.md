---
"@runfusion/fusion": patch
---

summary: Return the persisted prompt in task updates so prompt write read-back verifies.
category: fix
dev: `updateTask` now assigns the just-written prompt content onto the returned task — the PG `tasks` row has no `prompt` column, so the row re-read never hydrates it. The prompt-write tool's authoritative read-back compares against `updateTask`'s return, and the engine mock is aligned to the fixed store contract. Regression tests cover the read-back in core (in-memory + PG) and the engine tool path.
