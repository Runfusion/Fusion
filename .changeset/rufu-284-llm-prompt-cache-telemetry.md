---
"@runfusion/fusion": minor
---

summary: Measure LLM prompt-cache behaviour per lane with cache-read share, prompt heads and divergences.
category: feature
dev: Adds `token_usage`, `prompt_head` and `prompt_end` kinds on the existing `usage_events` table (no migration), a read-only `GET /api/command-center/llm-telemetry?window=10m|1h` aggregate, and a Command Center → Tokens panel. Stored metadata is hashes, byte counts and offsets only — prompt and response text are never persisted.
