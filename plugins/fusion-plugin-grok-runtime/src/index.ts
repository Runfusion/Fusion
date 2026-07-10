import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import { probeGrokBinary } from "./probe.js";
import { discoverGrokProviderModels } from "./provider.js";
import { GrokRuntimeAdapter } from "./runtime-adapter.js";

/*
FNXC:GrokCli 2026-07-08-00:00:
FN-7705: mirrors the landed Cursor Runtime plugin (FN-7697) end to end, with
one contract difference — Grok is API-key auth (GROK_API_KEY env var or
~/.grok/user-settings.json apiKey), not an OAuth/session CLI, so there is no
`grok status --format json` route; probe/authRoute here surface key-presence
auth state instead (see probe.ts). This shells out to an operator-installed
`grok` binary on PATH — Fusion does not download or bundle it.
*/
const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-grok-runtime",
    name: "Grok Runtime Plugin",
    version: "0.1.0",
    description: "Grok CLI runtime support for Fusion",
    runtime: {
      runtimeId: "grok",
      name: "Grok Runtime",
      version: "0.1.0",
    },
  },
  state: "installed",
  hooks: {},
  runtime: {
    metadata: {
      runtimeId: "grok",
      name: "Grok Runtime",
      version: "0.1.0",
    },
    factory: async () => new GrokRuntimeAdapter(),
  },
  cliProviders: [
    {
      providerId: "grok-cli",
      displayName: "Grok CLI",
      binaryName: "grok",
      providerType: "cli",
      statusRoute: "/providers/grok-cli/status",
      authRoute: "/auth/grok-cli",
      actions: [
        { actionId: "enable", label: "Enable", actionType: "enable", method: "POST", route: "/auth/grok-cli" },
        { actionId: "disable", label: "Disable", actionType: "disable", method: "POST", route: "/auth/grok-cli" },
        { actionId: "test", label: "Test", actionType: "test", method: "GET", route: "/providers/grok-cli/status" }
      ],
      probe: async () => {
        const status = await probeGrokBinary();
        return {
          available: status.available,
          authenticated: status.authenticated,
          binaryPath: status.binaryPath,
          binaryName: status.binaryName,
          version: status.version,
          reason: status.reason,
        };
      },
      discoverModels: discoverGrokProviderModels,
      runtime: {
        runtimeId: "grok",
        createAdapter: async () => new GrokRuntimeAdapter(),
      },
    },
  ],
});

export default plugin;
export { probeGrokBinary } from "./probe.js";
export { discoverGrokProviderModels } from "./provider.js";
export type { GrokBinaryStatus } from "./types.js";
