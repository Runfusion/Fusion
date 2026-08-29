/*
FNXC:ClaudeAcp 2026-07-11-16:00:
Vendored ACP client implementation for the Claude runtime. Copied from
plugins/fusion-plugin-acp-runtime/src (not imported) so the bundled Claude plugin
is self-contained and does not depend on the experimental/on-demand
fusion-plugin-acp-runtime package at runtime. Keep this tree focused on the
JSON-RPC/stdio client (connect, session, event bridge, permission floor,
process registry). Claude-specific spawn/auth/skills/MCP live outside this folder.
*/

export { AcpRuntimeAdapter } from "./runtime-adapter.js";
export { killAllProcesses } from "./process-manager.js";
export { authenticateAcpConnection, AcpAuthRequiredError, connect } from "./provider.js";
export { resolveCliSettings } from "./cli-spawn.js";
export type { AcpCliSettings } from "./cli-spawn.js";
export type { AcpMcpServer, AgentRuntimeOptions as AcpAgentRuntimeOptions } from "./types.js";
