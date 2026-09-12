---
"@runfusion/fusion": patch
---

summary: Prevent ACP agents from stalling when Fusion tool names are MCP-namespaced.
category: fix
dev: Adds tool-name mapping guidance only for tools actually registered on the session's custom-tool bridge.