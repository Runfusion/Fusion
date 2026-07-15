---
"@runfusion/fusion": patch
---

summary: Preserve legacy empty JSON text during PostgreSQL cutover.
category: fix
dev: Required jsonb columns without defaults now retain empty, whitespace-only, malformed, and scalar SQLite values without weakening nullable/default handling.
