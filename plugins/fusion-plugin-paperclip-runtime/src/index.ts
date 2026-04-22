/**
 * Paperclip Runtime Plugin
 *
 * Provides the Paperclip runtime for Fusion AI agents, backed by the user's
 * configured pi provider and model.
 *
 * ## Runtime Capabilities
 *
 * This plugin implements the AgentRuntime interface, providing:
 * - Session creation via createFnAgent
 * - Prompt with automatic retry and compaction
 * - Model description extraction
 * - Session disposal support
 */

import { definePlugin } from "@fusion/plugin-sdk";
import { PaperclipRuntimeAdapter } from "./runtime-adapter.js";
import type {
  FusionPlugin,
  PluginRuntimeRegistration,
} from "@fusion/plugin-sdk";

// ── Runtime Registration ─────────────────────────────────────────────────────

/**
 * Paperclip runtime factory.
 *
 * Creates a new PaperclipRuntimeAdapter instance when the runtime is resolved.
 *
 * @returns Promise resolving to a PaperclipRuntimeAdapter instance
 */
async function paperclipRuntimeFactory(): Promise<PaperclipRuntimeAdapter> {
  return new PaperclipRuntimeAdapter();
}

/**
 * Paperclip runtime registration for Fusion's plugin runtime system.
 * Uses the PluginRuntimeRegistration contract from FN-2256.
 */
const paperclipRuntime: PluginRuntimeRegistration = {
  metadata: {
    runtimeId: "paperclip",
    name: "Paperclip Runtime",
    description:
      "Paperclip-backed AI session using the user's configured pi provider and model",
    version: "1.0.0",
  },
  factory: paperclipRuntimeFactory,
};

// ── Plugin Definition ─────────────────────────────────────────────────────────

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
      description:
        "Paperclip-backed AI session using the user's configured pi provider and model",
      version: "1.0.0",
    },
  },
  state: "installed",
  runtime: paperclipRuntime,
  hooks: {
    onLoad: (ctx) => {
      ctx.logger.info("Paperclip Runtime Plugin loaded");
    },
  },
});

export default plugin;
