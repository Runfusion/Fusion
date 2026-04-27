import { definePlugin } from "@fusion/plugin-sdk";
import { probePaperclipInstance, resolvePaperclipConfig } from "./pi-module.js";
import { PaperclipRuntimeAdapter } from "./runtime-adapter.js";
import type {
  FusionPlugin,
  PluginRuntimeRegistration,
  RuntimeLogger,
} from "./types.js";

function getSettingsConfig(settings: unknown) {
  return resolvePaperclipConfig((settings ?? {}) as Record<string, unknown>);
}

async function paperclipRuntimeFactory(ctx: { settings?: unknown; logger?: RuntimeLogger }): Promise<unknown> {
  const config = getSettingsConfig(ctx.settings);
  return new PaperclipRuntimeAdapter(config, ctx.logger);
}

const paperclipRuntime: PluginRuntimeRegistration = {
  metadata: {
    runtimeId: "paperclip",
    name: "Paperclip Runtime",
    description: "Paperclip-backed AI session via Paperclip REST API",
    version: "1.0.0",
  },
  factory: paperclipRuntimeFactory,
};

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-paperclip-runtime",
    name: "Paperclip Runtime Plugin",
    version: "1.0.0",
    description: "Provides Paperclip runtime for Fusion AI agents",
    author: "Fusion Team",
    homepage: "https://github.com/gsxdsm/fusion",
    fusionVersion: ">=0.1.0",
    runtime: {
      runtimeId: "paperclip",
      name: "Paperclip Runtime",
      description: "Paperclip-backed AI session via Paperclip REST API",
      version: "1.0.0",
    },
  },
  state: "installed",
  runtime: paperclipRuntime,
  hooks: {
    onLoad: async (ctx) => {
      const config = getSettingsConfig(ctx.settings);
      ctx.logger.info(`Paperclip Runtime Plugin loaded (apiUrl=${config.apiUrl})`);

      const probe = await probePaperclipInstance(config.apiUrl, config.apiKey);
      if (probe.ok) {
        ctx.logger.info(
          `Paperclip probe succeeded (deploymentMode=${probe.deploymentMode ?? "unknown"})`,
        );
        return;
      }

      ctx.logger.warn(`Paperclip probe failed: ${probe.error}`);
    },
  },
});

export default plugin;
