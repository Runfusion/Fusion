---
"@runfusion/fusion": patch
---

summary: A code review revision reliably reopens implementation instead of stalling on an internal lock.
category: fix
dev: The graph-failure backstop and the failed-pre-merge-step sweep no longer take a fenced remediation claim; they re-trigger the single producer, matching Plan Review's shape. The claim guarded a bounded problem (a duplicate remediation wave, capped by the revision budget) at the cost of an unbounded one — any unclaimable round returned silently, before the "remediation was not scheduled" park. FN-267's actual fix, the ordering guard plus the deterministic Fix-step fallback, is untouched. The advisory refusal filter goes with the claim that wrote its marker.
