---
"@runfusion/fusion": patch
---

Add bootstrap-time branch misbinding recovery for contamination checks. The engine now classifies foreign-only contamination ranges with zero own/non-attributed commits, re-anchors the task branch to its intended base, audits the re-anchor event, and retries safely without pausing. Acquisition now also logs a warning when a `fusion/fn-*` start point resolves to a foreign task-attributed tip so future misbinding incidents are diagnosable.
