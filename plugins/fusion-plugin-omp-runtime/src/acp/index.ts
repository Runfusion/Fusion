/*
FNXC:OmpAcp 2026-07-11-23:35:
Vendored ACP client for the OMP runtime. Copied from
plugins/fusion-plugin-acp-runtime/src (via grok-runtime/src/acp) so this plugin
is self-contained and does not depend on the experimental/on-demand
fusion-plugin-acp-runtime package at runtime. Keep this tree focused on the
JSON-RPC/stdio client. OMP-specific spawn/auth live outside this folder.
*/

export { AcpRuntimeAdapter } from "./runtime-adapter.js";
export { killAllProcesses } from "./process-manager.js";
export {
  authenticateAcpConnection,
  AcpAuthRequiredError,
  connect,
  newAcpSession,
  promptAcpSession,
} from "./provider.js";
export { resolveCliSettings } from "./cli-spawn.js";
export type { AcpCliSettings } from "./cli-spawn.js";
export type { AcpMcpServer, AgentRuntimeOptions as AcpAgentRuntimeOptions } from "./types.js";
