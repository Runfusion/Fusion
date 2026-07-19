---
"@runfusion/fusion": patch
---

summary: Keep tasks running when an MCP server is temporarily unavailable.
category: fix
dev: Retries MCP bootstrap three times, then continues without servers that remain unavailable or lack resolved secrets.
