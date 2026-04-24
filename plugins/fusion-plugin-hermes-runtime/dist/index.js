/**
 * Hermes Runtime Plugin
 *
 * Provides an executable Hermes runtime adapter for Fusion's plugin runtime
 * discovery and session execution pipeline.
 */
import { definePlugin } from "@fusion/plugin-sdk";
import { HermesRuntimeAdapter } from "./runtime-adapter.js";
// ── Hermes Runtime Metadata ───────────────────────────────────────────────────
const HERMES_RUNTIME_ID = "hermes";
const HERMES_RUNTIME_VERSION = "0.1.0";
const hermesRuntimeMetadata = {
    runtimeId: HERMES_RUNTIME_ID,
    name: "Hermes Runtime",
    description: "Hermes-backed AI session using the user's configured pi provider and model",
    version: HERMES_RUNTIME_VERSION,
};
// ── Hermes Runtime Factory ────────────────────────────────────────────────────
const hermesRuntimeFactory = async () => {
    return new HermesRuntimeAdapter();
};
// ── Plugin Definition ─────────────────────────────────────────────────────────
const plugin = definePlugin({
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
            ctx.logger.info("Hermes Runtime Plugin loaded");
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
//# sourceMappingURL=index.js.map