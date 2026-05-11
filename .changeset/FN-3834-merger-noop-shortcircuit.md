---
"@runfusion/fusion": patch
---

Fixes a merger/self-healing recovery loop where in-review tasks with zero commits ahead of base were repeatedly re-enqueued forever. Fusion now detects deterministic no-op merge branches, marks them as no-op merge confirmed, and finalizes them to done instead of requeueing.