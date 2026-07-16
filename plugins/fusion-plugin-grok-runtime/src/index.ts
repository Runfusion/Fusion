import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import { killAllProcesses } from "./acp/index.js";
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

FNXC:GrokAcp 2026-07-11-12:00:
Prompt transport is now native ACP (`grok agent stdio`) via vendored
AcpRuntimeAdapter under ./acp/ — realtime session/update streaming, tool calls,
and multi-turn session reuse. Probe/model discovery still use the CLI.

FNXC:GrokAcp 2026-07-11-16:00:
ACP client code is copied into this plugin (src/acp/), not imported from
fusion-plugin-acp-runtime, so bundled Grok does not depend on the experimental
ACP example plugin package.
*/

/*
FNXC:ProcessLifecycle 2026-07-16-07:00:
The dashboard backfill worker repeatedly evaluates this plugin through
`vi.resetModules()` while retaining the process singleton. Install one exit
listener per Grok lifecycle owner and use the process-shared registry in the
ACP manager so it reaps children from every evaluation. Do not appease this
with `setMaxListeners`; the listener must stay bounded.
*/
const PROCESS_EXIT_HOOK_KEY = Symbol.for("fusion.plugin.grok-runtime.exitCleanup");
const processWithExitHook = process as typeof process & { [key: symbol]: boolean | undefined };
if (!processWithExitHook[PROCESS_EXIT_HOOK_KEY]) {
  process.on("exit", killAllProcesses);
  processWithExitHook[PROCESS_EXIT_HOOK_KEY] = true;
}

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-grok-runtime",
    name: "Grok Runtime Plugin",
    version: "0.2.0",
    description: "Grok CLI runtime support for Fusion (ACP agent stdio)",
    runtime: {
      runtimeId: "grok",
      name: "Grok Runtime",
      version: "0.2.0",
    },
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      ctx.logger.info(
        "Grok Runtime Plugin loaded — transport=ACP (grok agent stdio); probe uses grok --version",
      );
    },
  },
  runtime: {
    metadata: {
      runtimeId: "grok",
      name: "Grok Runtime",
      version: "0.2.0",
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
export { GrokRuntimeAdapter } from "./runtime-adapter.js";
export type { GrokBinaryStatus } from "./types.js";
