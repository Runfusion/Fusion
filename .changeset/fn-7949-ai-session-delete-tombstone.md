---
"@runfusion/fusion": patch
---

summary: Fix a deleted Planning Mode session silently reappearing after an in-flight generation finishes.
category: fix
dev: AiSessionStore now records a bounded-TTL delete tombstone (10 min) in `delete()`/`deleteByIdAndType()`/bulk cleanup paths; `upsert()` drops writes for tombstoned ids without emitting `ai_session:updated`. Fixes the root cause in the shared store rather than in `planning.ts`/`subtask-breakdown.ts`/`mission-interview.ts`/`milestone-slice-interview.ts`, so all AiSessionType producers are protected.
