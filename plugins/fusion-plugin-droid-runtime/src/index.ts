import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginRuntimeFactory, PluginRuntimeManifestMetadata } from "@fusion/plugin-sdk";
import { resolveCliSettings } from "./cli-spawn.js";
import { DroidRuntimeAdapter } from "./runtime-adapter.js";

export const DROID_RUNTIME_ID = "droid";
const DROID_RUNTIME_VERSION = "0.1.0";

export const droidRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: DROID_RUNTIME_ID,
  name: "Droid Runtime",
  description: "Drives the Droid CLI for Fusion agents",
  version: DROID_RUNTIME_VERSION,
};

export const droidRuntimeFactory: PluginRuntimeFactory = async (ctx) =>
  new DroidRuntimeAdapter(ctx.settings as Record<string, unknown> | undefined);

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-droid-runtime",
    name: "Droid Runtime Plugin",
    version: DROID_RUNTIME_VERSION,
    description: "Drives the Droid CLI for Fusion agents",
    runtime: droidRuntimeMetadata,
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      const settings = resolveCliSettings(ctx.settings as Record<string, unknown>);
      ctx.logger.info(`Droid Runtime Plugin loaded — binary=${settings.binaryPath} model=${settings.model ?? "(default)"}`);
    },
  },
  uiSlots: [
    {
      slotId: "settings-provider-card",
      label: "Droid CLI Provider",
      componentPath: "./components/settings-provider-card.js",
      order: 10,
    },
    {
      slotId: "settings-integration-card",
      label: "Droid CLI Integration",
      componentPath: "./components/settings-integration-card.js",
      order: 20,
    },
    {
      slotId: "onboarding-provider-card",
      label: "Droid CLI Provider",
      componentPath: "./components/onboarding-provider-card.js",
      order: 10,
    },
    {
      slotId: "onboarding-setup-help",
      label: "Droid CLI Setup Help",
      componentPath: "./components/onboarding-setup-help.js",
      order: 20,
    },
    {
      slotId: "post-onboarding-recommendation",
      label: "Droid CLI Recommendation",
      componentPath: "./components/post-onboarding-recommendation.js",
      order: 10,
    },
  ],
  runtime: {
    metadata: droidRuntimeMetadata,
    factory: droidRuntimeFactory,
  },
});

export default plugin;
export { DroidRuntimeAdapter };
export { probeDroidBinary } from "./probe.js";
export type { DroidBinaryStatus } from "./probe.js";
export { streamViaCli } from "./provider.js";
export {
  discoverDroidModels,
  validateCliPresenceAsync,
  validateCliAuthAsync,
  killAllProcesses,
} from "./process-manager.js";
export { getCustomToolDefs, toolsFromContext, writeMcpConfig } from "./mcp-config.js";
export type { McpToolDef } from "./mcp-config.js";
