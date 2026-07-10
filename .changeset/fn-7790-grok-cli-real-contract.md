---
"@runfusion/fusion": patch
---

summary: Fix Grok CLI runtime sends to stream responses from xAI's real grok binary.
category: fix
dev: Uses `grok -p --output-format streaming-json` and parses `thought`/`text`/`end` events.
