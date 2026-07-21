---
"@runfusion/fusion": patch
---

summary: Same-agent near-duplicates stay on the board by default on all create paths (no silent auto-archive).
category: fix
dev: Aligns PostgreSQL createTaskBackend same-agent intake with FN-7658 flagSameAgentDuplicate; removes divergent delete-on-match backend path; keeps sticky tombstone near-duplicate blocking on both backends.
