import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginRuntimeFactory, PluginRuntimeManifestMetadata } from "@fusion/plugin-sdk";
import { resolveCliSettings } from "./cli-spawn.js";
import { AcpRuntimeAdapter } from "./runtime-adapter.js";

export const ACP_RUNTIME_ID = "acp";
const ACP_RUNTIME_VERSION = "0.1.0";

export const acpRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: ACP_RUNTIME_ID,
  name: "ACP Runtime",
  description: "Drives any external ACP-compatible agent over JSON-RPC/stdio",
  version: ACP_RUNTIME_VERSION,
};

export const acpRuntimeFactory: PluginRuntimeFactory = async (ctx) =>
  new AcpRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined);

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-acp-runtime",
    name: "ACP Runtime Plugin",
    version: ACP_RUNTIME_VERSION,
    description: "Drives any external ACP-compatible agent over JSON-RPC/stdio",
    runtime: acpRuntimeMetadata,
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      const settings = resolveCliSettings(ctx.settings as Record<string, unknown>);
      ctx.logger.info(
        `ACP Runtime Plugin loaded — binary=${settings.binaryPath} args=[${settings.args.join(" ")}] ` +
          `fsRead=${settings.fsRead} fsWrite=${settings.fsWrite}`,
      );
    },
  },
  runtime: {
    metadata: acpRuntimeMetadata,
    factory: acpRuntimeFactory,
  },
});

export default plugin;
export { AcpRuntimeAdapter };
export { resolveCliSettings } from "./cli-spawn.js";
export type { AcpCliSettings } from "./cli-spawn.js";
