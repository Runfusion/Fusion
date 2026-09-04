---
"@runfusion/fusion": patch
---

summary: Return the persisted prompt in task updates so prompt write read-back verifies.
category: fix
dev: `updateTask` assigns the prompt onto the returned task only after PROMPT.md reaches disk, and current-plan evidence is captured only after that write — the PG `tasks` row has no `prompt` column, so the row re-read never hydrates it, and a failed file write cannot leak the unwritten revision into metadata or spec-lock evidence. The prompt-write tool's authoritative read-back compares against `updateTask`'s return, and the engine mock is aligned to the fixed store contract. Regression tests cover the read-back in core (in-memory + PG), write-failure isolation, and the engine tool path.
