import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import { discoverAntigravityProviderModels, probeAntigravityBinary } from "./probe.js";
import { AntigravityRuntimeAdapter } from "./runtime-adapter.js";
const plugin: FusionPlugin = definePlugin({
  manifest: { id: "fusion-plugin-antigravity-runtime", name: "Google Antigravity Runtime Plugin", version: "0.1.0", description: "Google Antigravity agy CLI streaming runtime support", runtime: { runtimeId: "antigravity", name: "Google Antigravity Runtime", version: "0.1.0" } },
  state: "installed", hooks: {},
  runtime: { metadata: { runtimeId: "antigravity", name: "Google Antigravity Runtime", version: "0.1.0" }, factory: async (ctx) => new AntigravityRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined) },
  cliProviders: [{ providerId: "antigravity-cli", displayName: "Google Antigravity CLI", binaryName: "agy", providerType: "cli", statusRoute: "/providers/antigravity-cli/status", authRoute: "/auth/antigravity-cli", actions: [{ actionId: "enable", label: "Enable", actionType: "enable", method: "POST", route: "/auth/antigravity-cli" }, { actionId: "disable", label: "Disable", actionType: "disable", method: "POST", route: "/auth/antigravity-cli" }], probe: async () => probeAntigravityBinary(), discoverModels: async () => discoverAntigravityProviderModels(), runtime: { runtimeId: "antigravity", createAdapter: async (ctx) => new AntigravityRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined) } }],
});
export default plugin;
export { probeAntigravityBinary, discoverAntigravityProviderModels } from "./probe.js";
export { AntigravityRuntimeAdapter } from "./runtime-adapter.js";
export type { AntigravityBinaryStatus } from "./types.js";
