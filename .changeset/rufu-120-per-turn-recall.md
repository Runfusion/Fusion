---
"@runfusion/fusion": minor
---

summary: Per-turn memory recall injects a short, deduped memory cue before each chat or task turn to keep agents on topic.
category: feature
dev: Adds project settings `memoryPerTurnRecallEnabled` (default `true`) and `memoryPerTurnRecallTopK` (default `3`). Before each LLM call on the dashboard chat path and at every executor step session, a bounded per-turn recall (2-3 normalized keywords, top-K snippets, client-side score filter, session/task-scoped dedup, ~200-token cap) runs against the current topic via `MemoryBackend.search` only and appends a deduped cue reusing the existing pre-steering marker format. Silent skip on empty results, full dedup, or an unavailable backend. The CLI-agent PTY chat path is intentionally untouched in v1 (the CLI process owns the prompt).
