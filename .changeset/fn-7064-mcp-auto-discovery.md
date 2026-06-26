---
"@runfusion/fusion": minor
---

summary: Auto-discover MCP servers from Claude/Cursor/Windsurf/VS Code and opt-in to enable them in Settings.
category: feature
dev: New @fusion/core mcp-discovery source resolution + parser, @fusion/engine discoverMcpServers fs reader, GET /api/mcp/discovered route, and a discovered region in McpServersCard. Read-only/opt-in; discovered secrets become Fusion secret references, never plaintext.
