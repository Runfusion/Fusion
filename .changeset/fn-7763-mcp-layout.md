---
"@runfusion/fusion": patch
---

summary: Fix oversized icons and spacing on the MCP servers settings page.
category: fix
dev: McpServersCard inline lucide icons now use --icon-size-sm/md token values; .btn > svg is unsized globally so they previously fell back to lucide's 24px default.
