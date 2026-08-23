---
"@runfusion/fusion": minor
---

summary: Add opt-in semantic (vector) recall for Stash memory via a new stashVectorSearch setting.
category: feature
dev: StashMemoryBackend.search tries GET /api/v1/me/sessions/events/semantic-search first for multi-word (>=2 token) queries when the per-project stashVectorSearch setting is true (default false — zero behavior change until enabled). Any vector failure (network, non-2xx, malformed, empty) falls back byte-identically to the existing RUFU-121 keyword path, and definitive 404/405/501/503 responses are negatively cached per process (1h TTL). Vector scores are cosine similarity (0..1), a different scale than keyword positional scores. Requires a patched Stash server (local upstream branch fusion-rufu-126-sessions-semantic-search: new endpoint + sentence-transformers + embedding backfill task); unpatched servers are transparently bypassed after the first 404.
