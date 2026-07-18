/*
FNXC:CliTests 2026-07-18-09:15:
Thin entry for dashboard runtime-provider-probes and CLI vitest source aliases.
Importing the full plugin index pulls ACP/runtime-adapter (and @agentclientprotocol/sdk)
which is not required for binary probe / model discovery and fails full-suite CLI
resolution when dist/ is absent or ACP deps are not on the CLI resolver path.
*/
export { probeClaudeBinary, type ClaudeBinaryStatus } from "./probe.js";
export { discoverClaudeProviderModels } from "./provider.js";
