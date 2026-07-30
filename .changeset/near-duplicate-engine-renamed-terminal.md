---
"@runfusion/fusion": patch
---

summary: Duplicate-decision cards no longer stay parked forever when the canonical finishes on a renamed board.
category: fix
dev: The five engine call sites of `isNearDuplicateCanonicalInactive` (self-healing x2, triage x3) now resolve the canonical's own column flags; previously they fell back to the legacy `done`/`archived` ids, so FN-8356's marker cleanup never fired on a custom board.
