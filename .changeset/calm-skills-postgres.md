---
"@runfusion/fusion": patch
"@fusion/core": patch
---

summary: Fix dashboard skill discovery lifecycle in PostgreSQL mode.
category: fix
dev: Reuse and close backend-aware project stores, keep request-scoped discovery loaders from mutating persistent plugin runtime state, and make cluster-wide PostgreSQL runtime-role creation race-safe.
