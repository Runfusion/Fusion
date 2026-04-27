/**
 * OpenClaw Runtime Plugin
 *
 * Provides an executable OpenClaw runtime adapter for Fusion's plugin runtime
 * discovery and session execution pipeline.
 */
import { definePlugin } from "@fusion/plugin-sdk";
import { OpenClawRuntimeAdapter } from "./runtime-adapter.js";
import { probeGateway, resolveGatewayConfig } from "./pi-module.js";
const OPENCLAW_RUNTIME_ID = "openclaw";
const OPENCLAW_RUNTIME_VERSION = "0.1.0";
const openclawRuntimeMetadata = {
    runtimeId: OPENCLAW_RUNTIME_ID,
    name: "OpenClaw Runtime",
    description: "OpenClaw-backed AI session using the local OpenClaw gateway",
    version: OPENCLAW_RUNTIME_VERSION,
};
const openclawRuntimeFactory = async (ctx) => {
    const config = resolveGatewayConfig(ctx?.settings);
    return new OpenClawRuntimeAdapter(config);
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
        onLoad: async (ctx) => {
            const config = resolveGatewayConfig(ctx.settings);
            const gatewayReachable = await probeGateway(config.gatewayUrl);
            ctx.logger.info(`OpenClaw Runtime Plugin loaded (gateway: ${config.gatewayUrl}, reachable: ${gatewayReachable ? "yes" : "no"})`);
            ctx.emitEvent("openclaw-runtime:loaded", {
                runtimeId: OPENCLAW_RUNTIME_ID,
                version: OPENCLAW_RUNTIME_VERSION,
                gatewayUrl: config.gatewayUrl,
                gatewayReachable,
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