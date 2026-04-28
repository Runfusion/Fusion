/**
 * OpenClaw Runtime Plugin
 *
 * Drives the local `openclaw` CLI as a subprocess (via
 * `openclaw --no-color agent --local --json`). No daemon required.
 */
import { definePlugin } from "@fusion/plugin-sdk";
import { OpenClawRuntimeAdapter } from "./runtime-adapter.js";
import { resolveCliConfig } from "./pi-module.js";
import { probeOpenClawBinary } from "./probe.js";
const OPENCLAW_RUNTIME_ID = "openclaw";
const OPENCLAW_RUNTIME_VERSION = "0.2.0";
const openclawRuntimeMetadata = {
    runtimeId: OPENCLAW_RUNTIME_ID,
    name: "OpenClaw Runtime",
    description: "Drives the local `openclaw` CLI (openclaw/openclaw)",
    version: OPENCLAW_RUNTIME_VERSION,
};
const openclawRuntimeFactory = async (ctx) => {
    return new OpenClawRuntimeAdapter(ctx?.settings);
};
const plugin = definePlugin({
    manifest: {
        id: "fusion-plugin-openclaw-runtime",
        name: "OpenClaw Runtime Plugin",
        version: OPENCLAW_RUNTIME_VERSION,
        description: "Drives the local `openclaw` CLI for Fusion agents — embedded `--local` mode by default; gateway optional.",
        author: "Fusion Team",
        homepage: "https://docs.openclaw.ai/",
        runtime: openclawRuntimeMetadata,
    },
    state: "installed",
    hooks: {
        onLoad: async (ctx) => {
            const config = resolveCliConfig(ctx.settings);
            const probe = await probeOpenClawBinary({ binaryPath: config.binaryPath });
            ctx.logger.info(probe.available
                ? `OpenClaw Runtime Plugin loaded — binary=${config.binaryPath}${probe.version ? ` (${probe.version})` : ""}`
                : `OpenClaw Runtime Plugin loaded but binary not detected: ${probe.reason ?? "unknown"}`);
            ctx.emitEvent("openclaw-runtime:loaded", {
                runtimeId: OPENCLAW_RUNTIME_ID,
                version: OPENCLAW_RUNTIME_VERSION,
                binaryAvailable: probe.available,
                binaryPath: probe.binaryPath ?? config.binaryPath,
            });
        },
        onUnload: () => {
            // No persistent state to clean up — each prompt spawns a fresh subprocess.
        },
    },
    runtime: {
        metadata: openclawRuntimeMetadata,
        factory: openclawRuntimeFactory,
    },
});
export default plugin;
// ── Public exports ────────────────────────────────────────────────────────────
export { openclawRuntimeMetadata, openclawRuntimeFactory, OPENCLAW_RUNTIME_ID };
export { OpenClawRuntimeAdapter } from "./runtime-adapter.js";
export { resolveCliConfig, buildOpenClawArgs, createCliSession, promptCli, describeCliModel, extractStderrError, } from "./pi-module.js";
// Probe re-export for the dashboard's runtime-provider-probes façade.
export { probeOpenClawBinary } from "./probe.js";
//# sourceMappingURL=index.js.map