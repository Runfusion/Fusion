---
"@runfusion/fusion": minor
---

summary: ACP runtimes can now expose Fusion custom tools (fn_*) to external agents such as Hermes ACP and Prime.
category: feature
dev: AcpRuntimeAdapter starts a per-session loopback tool bridge and registers it as a stdio MCP server in session/new.mcpServers when the engine passes customTools; the bridge authenticates requests with a per-session bearer token, threads the real MCP request id as the toolCallId, and is disposed on session/new failure and session teardown. Build copies mcp-schema-server.cjs beside dist (tsc does not copy .cjs assets).
