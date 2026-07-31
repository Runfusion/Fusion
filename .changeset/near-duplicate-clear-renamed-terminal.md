---
"@runfusion/fusion": patch
---

summary: Duplicate flags now clear when the canonical task finishes on a renamed board.
category: fix
dev: `clearNearDuplicateReferencesTo` resolves the canonical's own column flags before calling `isNearDuplicateCanonicalInactive`, which otherwise fell back to the legacy `done`/`archived` ids and read a completed canonical as still active, leaving `nearDuplicateOf` markers set forever.
