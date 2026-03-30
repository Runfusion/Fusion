---
"@dustinbyrne/kb": minor
---

Handle transient connection failures without marking tasks as failed. When the AI agent encounters network errors like "upstream connect error", "ECONNREFUSED", or "connection reset", tasks are now moved back to "todo" for automatic retry instead of being marked as failed. This prevents temporary infrastructure issues from incorrectly failing tasks.
