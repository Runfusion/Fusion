---
"@runfusion/fusion": patch
---

summary: Remote-agent turns reach Fusion within about a second, and catch-up after an outage stays under the rate limit.
category: feature
dev: New `POST /api/external-sessions/turn-ingest-batch` takes up to 50 turns (8 MiB body) and answers each separately; collectors scan before delivering, wake from native hooks through a private socket, reuse one keep-alive connection and fall back to single turns on builds without the route. A core test validates the Python parser's output against the turn contract.
