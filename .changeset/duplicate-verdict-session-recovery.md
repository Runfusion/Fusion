---
"@runfusion/fusion": patch
---

summary: A duplicate task is now parked for your keep-or-delete decision even if the planner only says so in its reply.
category: fix
dev: New `parseDuplicateMarkerFromSessionText` (line-anchored, first-match-only) plus a bounded tail of the planner's streamed text in `TriageProcessor.specifyTask`. When the finalize read finds no spec, a duplicate verdict recovered from the reply is written out as the canonical `DUPLICATE: FN-NNNN` marker file, so marker parsing, keep/delete resolution, and the `sourceMetadata.nearDuplicateOf` the dashboard decision renders from all run on the unchanged file contract. Gated on an absent plan, so a planner that wrote a real spec is never overridden by prose.
