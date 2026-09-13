---
"@runfusion/fusion": patch
---

summary: Prevent ACP agents from stalling when Fusion tool names are MCP-namespaced.
category: fix
dev: Adds tool-name mapping guidance for tools actually registered on the session's custom-tool bridge. Covers the bundled Claude, Grok, and OMP runtimes, which keep their own vendored ACP adapters, and hedges the namespaced spelling per client convention.
