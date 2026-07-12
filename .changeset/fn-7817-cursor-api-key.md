---
"@runfusion/fusion": minor
---

summary: Add a documented CURSOR_API_KEY credential path for Cursor usage metering.
category: feature
dev: usage.ts adds readCursorApiKey (CURSOR_API_KEY env var → cursor authStorage entry, mirroring readGrokApiKey); settings-reference.md documents it and clarifies cursor-cli runtime OAuth vs the usage/admin API key. Unblocks FN-7816. Cursor usage-API specifics confirmed via Cursor Admin API docs: POST /teams/spend with Basic auth using an admin:* API key as the username.
