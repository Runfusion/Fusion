import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import { killAllProcesses } from "./acp/index.js";
import { probeClaudeBinary } from "./probe.js";
import { discoverClaudeProviderModels } from "./provider.js";
import { ClaudeRuntimeAdapter } from "./runtime-adapter.js";

/*
FNXC:ClaudeAcpRuntime 2026-07-17-12:00:
FN-8224 adds a first-class Claude ACP runtime. It composes the reviewed,
identity-pinned claude-code-cli-acp bridge, mirrors the bundled Grok runtime,
and is additive to the existing experimental pi-claude-cli Route A.
*/

/*
FNXC:ProcessLifecycle 2026-07-16-07:00:
The dashboard backfill worker repeatedly evaluates this plugin through
`vi.resetModules()` while retaining the process singleton. Install one exit
listener per Claude lifecycle owner and use the process-shared registry in the
ACP manager so it reaps children from every evaluation. Do not appease this
with `setMaxListeners`; the listener must stay bounded.
*/
const PROCESS_EXIT_HOOK_KEY = Symbol.for("fusion.plugin.claude-runtime.exitCleanup");
const processWithExitHook = process as typeof process & { [key: symbol]: boolean | undefined };
if (!processWithExitHook[PROCESS_EXIT_HOOK_KEY]) {
  process.on("exit", killAllProcesses);
  processWithExitHook[PROCESS_EXIT_HOOK_KEY] = true;
}

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-claude-runtime",
    name: "Claude Runtime Plugin",
    version: "0.1.0",
    description: "Claude CLI runtime support for Fusion (ACP agent stdio)",
    runtime: {
      runtimeId: "claude",
      name: "Claude Runtime",
      version: "0.1.0",
    },
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      ctx.logger.info(
        "Claude Runtime Plugin loaded — transport=ACP (claude-code-cli-acp); probe uses claude --version",
      );
    },
  },
  runtime: {
    metadata: {
      runtimeId: "claude",
      name: "Claude Runtime",
      version: "0.1.0",
    },
    factory: async () => new ClaudeRuntimeAdapter(),
  },
  cliProviders: [
    {
      providerId: "claude-cli",
      displayName: "Claude CLI",
      binaryName: "claude",
      providerType: "cli",
      statusRoute: "/providers/claude-cli/status",
      authRoute: "/auth/claude-cli",
      actions: [
        { actionId: "enable", label: "Enable", actionType: "enable", method: "POST", route: "/auth/claude-cli" },
        { actionId: "disable", label: "Disable", actionType: "disable", method: "POST", route: "/auth/claude-cli" },
        { actionId: "test", label: "Test", actionType: "test", method: "GET", route: "/providers/claude-cli/status" }
      ],
      probe: async () => {
        const status = await probeClaudeBinary();
        return {
          available: status.available,
          authenticated: status.authenticated,
          binaryPath: status.binaryPath,
          binaryName: status.binaryName,
          version: status.version,
          reason: status.reason,
        };
      },
      discoverModels: discoverClaudeProviderModels,
      runtime: {
        runtimeId: "claude",
        createAdapter: async () => new ClaudeRuntimeAdapter(),
      },
    },
  ],
});

export default plugin;
export { probeClaudeBinary } from "./probe.js";
export { discoverClaudeProviderModels } from "./provider.js";
export { ClaudeRuntimeAdapter } from "./runtime-adapter.js";
export type { ClaudeBinaryStatus } from "./types.js";
