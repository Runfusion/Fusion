---
"@runfusion/fusion": patch
---

summary: Prevent oversized task drafts from exhausting browser storage.
category: fix
dev: Scoped draft writes return a persistence result, cap free text at 64,000 bytes, and reclaim stale entries after quota failures.
