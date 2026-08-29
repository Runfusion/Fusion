---
"@runfusion/fusion": minor
---

summary: Add the Stash memory backend with complete-chat-session and per-task capture.
category: feature
dev: Adds the Stash memory backend (memory.backendType=stash), memory.stashUrl / memory.stashApiKey settings (global secrets-store "stash-api-key" + per-project override), complete-chat-session capture keyed by ChatSession id, per-conversation memory-focus read-time scoping via the new 0059_chat_session_memory_focus.sql migration (SCHEMA_BASELINE_VERSION -> 0059), and per-task task_completion capture. Best-effort/fail-closed/non-blocking; no run-audit content.