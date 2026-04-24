/**
 * OpenClaw Runtime Plugin
 *
 * Provides an executable OpenClaw runtime adapter for Fusion's plugin runtime
 * discovery and session execution pipeline.
 */
import { definePlugin } from "@fusion/plugin-sdk";
import { OpenClawRuntimeAdapter } from "./runtime-adapter.js";
const OPENCLAW_RUNTIME_ID = "openclaw";
const OPENCLAW_RUNTIME_VERSION = "0.1.0";
const openclawRuntimeMetadata = {
    runtimeId: OPENCLAW_RUNTIME_ID,
    name: "OpenClaw Runtime",
    description: "OpenClaw-backed AI session using the user's configured pi provider and model",
    version: OPENCLAW_RUNTIME_VERSION,
};
const openclawRuntimeFactory = async () => {
    return new OpenClawRuntimeAdapter();
};
const plugin = definePlugin({
    manifest: {
        id: "fusion-plugin-openclaw-runtime",
        name: "OpenClaw Runtime Plugin",
        version: "0.1.0",
        description: "Provides OpenClaw runtime for Fusion AI agents",
        author: "Fusion Team",
        homepage: "https://github.com/gsxdsm/fusion",
        runtime: openclawRuntimeMetadata,
    },
    state: "installed",
    hooks: {
        onLoad: (ctx) => {
            ctx.logger.info("OpenClaw Runtime Plugin loaded");
            ctx.emitEvent("openclaw-runtime:loaded", {
                runtimeId: OPENCLAW_RUNTIME_ID,
                version: OPENCLAW_RUNTIME_VERSION,
            });
        },
        onUnload: () => {
            // No context available during unload
        },
    },
    runtime: {
        metadata: openclawRuntimeMetadata,
        factory: openclawRuntimeFactory,
    },
});
export default plugin;
export { openclawRuntimeMetadata, openclawRuntimeFactory, OPENCLAW_RUNTIME_ID };
//# sourceMappingURL=index.js.map