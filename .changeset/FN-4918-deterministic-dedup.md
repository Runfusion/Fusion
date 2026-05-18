---
"@runfusion/fusion": patch
---

Add deterministic duplicate guard at task intake: identical-content POSTs within a 60s window are rejected with `409 duplicate_candidates` or auto-archived with a `source.sourceMetadata.deterministicDuplicateOf` lineage marker. Complements the existing FN-4829 similarity warning.
