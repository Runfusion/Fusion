---
"@runfusion/fusion": patch
---

summary: Fix the built-in Fusion memory MCP server being skipped in agent sessions.
category: fix
dev: MemoryMcpHandler now emits the serverInfo.version required by the SDK InitializeResultSchema.
