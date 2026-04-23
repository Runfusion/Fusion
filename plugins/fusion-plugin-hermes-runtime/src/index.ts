/**
 * Hermes Runtime Plugin
 *
 * Provides Hermes AI runtime capabilities for Fusion tasks.
 * This plugin registers the Hermes runtime with the Fusion plugin system.
 *
 * Note: Full runtime behavior is deferred to FN-2264.
 * Any runtime invocation will return a "not implemented" signal.
 */

import { definePlugin } from "@fusion/plugin-sdk";
import type {
  FusionPlugin,
  PluginContext,
  PluginRuntimeFactory,
  PluginRuntimeManifestMetadata,
} from "@fusion/plugin-sdk";

// ── Hermes Runtime Metadata ───────────────────────────────────────────────────

const HERMES_RUNTIME_ID = "hermes";
const HERMES_RUNTIME_VERSION = "0.1.0";

const hermesRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: HERMES_RUNTIME_ID,
  name: "Hermes Runtime",
  description: "Experimental Hermes runtime integration for Fusion tasks (implementation deferred to FN-2264)",
  version: HERMES_RUNTIME_VERSION,
};

// ── Hermes Runtime Factory ────────────────────────────────────────────────────

/**
 * Factory function for creating the Hermes runtime instance.
 *
 * This is a placeholder implementation. Full runtime behavior is deferred to FN-2264.
 * Any runtime invocation will throw a descriptive error referencing FN-2264.
 *
 * @param _ctx - Plugin context (unused in placeholder)
 * @throws Error with message referencing FN-2264 for full implementation
 */
const hermesRuntimeFactory: PluginRuntimeFactory = (_ctx: PluginContext) => {
  // Return a placeholder object that signals deferred implementation
  return {
    runtimeId: HERMES_RUNTIME_ID,
    version: HERMES_RUNTIME_VERSION,
    status: "deferred",
    message: `Hermes runtime implementation is deferred to FN-2264. ` +
             `Current invocation is a placeholder.`,
    execute: async () => {
      throw new Error(
        `Hermes runtime is not yet implemented. ` +
        `Full implementation deferred to FN-2264. ` +
        `See https://github.com/gsxdsm/fusion/issues/FN-2264`,
      );
    },
  };
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
      ctx.logger.info("Hermes Runtime Plugin loaded (placeholder - FN-2264 pending)");
      ctx.emitEvent("hermes-runtime:loaded", {
        runtimeId: HERMES_RUNTIME_ID,
        version: HERMES_RUNTIME_VERSION,
        status: "deferred",
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
