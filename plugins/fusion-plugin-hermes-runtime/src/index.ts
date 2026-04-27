/**
 * Hermes Runtime Plugin
 *
 * Provides an executable Hermes runtime adapter for Fusion's plugin runtime
 * discovery and session execution pipeline.
 */

import { definePlugin } from "@fusion/plugin-sdk";
import { resolveModelConfig } from "./pi-module.js";
import { HermesRuntimeAdapter } from "./runtime-adapter.js";
import type {
  FusionPlugin,
  PluginRuntimeFactory,
  PluginRuntimeManifestMetadata,
} from "@fusion/plugin-sdk";

// ── Hermes Runtime Metadata ───────────────────────────────────────────────────

const HERMES_RUNTIME_ID = "hermes";
const HERMES_RUNTIME_VERSION = "0.1.0";

const hermesRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: HERMES_RUNTIME_ID,
  name: "Hermes Runtime",
  description: "Hermes raw-model runtime using pi-ai direct streaming",
  version: HERMES_RUNTIME_VERSION,
};

// ── Hermes Runtime Factory ────────────────────────────────────────────────────

const hermesRuntimeFactory: PluginRuntimeFactory = async (ctx) => {
  const config = resolveModelConfig(ctx.settings);

  return new HermesRuntimeAdapter({
    provider: config.provider,
    modelId: config.modelId,
    apiKey: config.apiKey,
    thinkingLevel: config.thinkingLevel,
  });
};

// ── Plugin Definition ─────────────────────────────────────────────────────────

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-hermes-runtime",
    name: "Hermes Runtime Plugin",
    version: "0.1.0",
    description: "Hermes AI runtime plugin for Fusion - provides AI agent execution runtime capabilities",
    author: "Fusion Team",
    homepage: "https://github.com/gsxdsm/fusion",
    runtime: hermesRuntimeMetadata,
  },
  state: "installed",
  hooks: {
    onLoad: (ctx) => {
      const config = resolveModelConfig(ctx.settings);
      ctx.logger.info(`Hermes Runtime Plugin loaded — using ${config.provider}/${config.modelId}`);
      ctx.emitEvent("hermes-runtime:loaded", {
        runtimeId: HERMES_RUNTIME_ID,
        version: HERMES_RUNTIME_VERSION,
      });
    },
    onUnload: () => {
      // No context available during unload
    },
  },
  runtime: {
    metadata: hermesRuntimeMetadata,
    factory: hermesRuntimeFactory,
  },
});

export default plugin;

// ── Exports for Testing ───────────────────────────────────────────────────────

export { hermesRuntimeMetadata, hermesRuntimeFactory, HERMES_RUNTIME_ID };
