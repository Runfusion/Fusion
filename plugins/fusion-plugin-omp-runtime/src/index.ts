import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin } from "@fusion/plugin-sdk";
/*
FNXC:ProcessLifecycle 2026-07-16-07:00 / 2026-07-18-08:10:
Exit-hook ownership lives in ./acp/process-manager (Symbol.for guard + shared
registry). Import that module from the plugin entry so plugin load still arms
the process.exit reaper; re-evaluation stays bounded by the Symbol.for guard.
*/
import "./acp/process-manager.js";
import { probeOmpBinary } from "./probe.js";
import { discoverOmpProviderModels } from "./provider.js";
import { OmpRuntimeAdapter } from "./runtime-adapter.js";

/*
FNXC:OmpAcp 2026-07-11-23:35:
OMP Runtime plugin — drive Oh My Pi (`omp`) as a Fusion agent runtime over the
Agent Client Protocol. Transport is `omp acp` (JSON-RPC/stdio). Mirrors the
landed Grok ACP runtime pattern (vendored ACP client under ./acp/) with
OMP-specific binary/args/auth (agent auth reuses ~/.omp).

This shells out to an operator-installed `omp` binary on PATH — Fusion does not
download or bundle it. Upstream: https://omp.sh/docs/acp
https://github.com/can1357/oh-my-pi
*/

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-omp-runtime",
    name: "OMP Runtime Plugin",
    version: "0.1.0",
    description: "Oh My Pi (omp) runtime support for Fusion via ACP (omp acp)",
    author: "Fusion Team",
    homepage: "https://omp.sh/docs/acp",
    runtime: {
      runtimeId: "omp",
      name: "OMP Runtime",
      version: "0.1.0",
      description: "Drives the local `omp acp` Agent Client Protocol server",
    },
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      ctx.logger.info(
        "OMP Runtime Plugin loaded — transport=ACP (omp acp); probe uses omp --version",
      );
    },
  },
  runtime: {
    metadata: {
      runtimeId: "omp",
      name: "OMP Runtime",
      version: "0.1.0",
      description: "Drives the local `omp acp` Agent Client Protocol server",
    },
    factory: async () => new OmpRuntimeAdapter(),
  },
  cliProviders: [
    {
      providerId: "omp-cli",
      displayName: "Oh My Pi (omp)",
      binaryName: "omp",
      providerType: "cli",
      statusRoute: "/providers/omp-cli/status",
      authRoute: "/auth/omp-cli",
      actions: [
        { actionId: "enable", label: "Enable", actionType: "enable", method: "POST", route: "/auth/omp-cli" },
        { actionId: "disable", label: "Disable", actionType: "disable", method: "POST", route: "/auth/omp-cli" },
        { actionId: "test", label: "Test", actionType: "test", method: "GET", route: "/providers/omp-cli/status" },
      ],
      probe: async () => {
        const status = await probeOmpBinary();
        return {
          available: status.available,
          authenticated: status.authenticated,
          binaryPath: status.binaryPath,
          binaryName: status.binaryName,
          version: status.version,
          reason: status.reason,
        };
      },
      discoverModels: discoverOmpProviderModels,
      runtime: {
        runtimeId: "omp",
        createAdapter: async () => new OmpRuntimeAdapter(),
      },
    },
  ],
});

export default plugin;
export { probeOmpBinary } from "./probe.js";
export { discoverOmpProviderModels } from "./provider.js";
export { discoverOmpModels, resolveOmpModelSelector } from "./process-manager.js";
export { OmpRuntimeAdapter } from "./runtime-adapter.js";
export type { OmpBinaryStatus } from "./types.js";
export {
  buildOmpAcpArgs,
  buildOmpAcpRuntimeSettings,
  OMP_ACP_ENV_ALLOWLIST,
  modelForCli,
  normalizeOmpCliModel,
  resolveOmpAcpAuthPreferMethods,
} from "./acp-settings.js";
export { startFusionToolBridge, toolsToMcpToolDefs, FUSION_OMP_TOOL_BRIDGE_URL } from "./tool-bridge.js";
export { toAcpMcpServers } from "./mcp-forwarding.js";
export { buildOmpFusionToolRules } from "./runtime-adapter.js";
