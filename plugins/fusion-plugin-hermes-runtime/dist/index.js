/**
 * Hermes Runtime Plugin
 *
 * Provides an executable Hermes runtime adapter that drives the local `hermes`
 * CLI as a subprocess. Discovered by Fusion's plugin runtime registry; the
 * settings configured in the dashboard's "Runtimes → Hermes" page flow through
 * `ctx.settings` into the CLI invocation.
 */
import { definePlugin } from "@fusion/plugin-sdk";
import { resolveCliSettings } from "./cli-spawn.js";
import { HermesRuntimeAdapter } from "./runtime-adapter.js";
// ── Hermes Runtime Metadata ───────────────────────────────────────────────────
const HERMES_RUNTIME_ID = "hermes";
const HERMES_RUNTIME_VERSION = "0.2.0";
const hermesRuntimeMetadata = {
    runtimeId: HERMES_RUNTIME_ID,
    name: "Hermes Runtime",
    description: "Drives the local `hermes` CLI (NousResearch/hermes-agent)",
    version: HERMES_RUNTIME_VERSION,
};
// ── Hermes Runtime Factory ────────────────────────────────────────────────────
const hermesRuntimeFactory = async (ctx) => {
    return new HermesRuntimeAdapter(ctx.settings);
};
// ── Plugin Definition ─────────────────────────────────────────────────────────
const plugin = definePlugin({
    manifest: {
        id: "fusion-plugin-hermes-runtime",
        name: "Hermes Runtime Plugin",
        version: HERMES_RUNTIME_VERSION,
        description: "Drives the local `hermes` CLI for Fusion agents — captures session ids and resumes via --resume.",
        author: "Fusion Team",
        homepage: "https://github.com/NousResearch/hermes-agent",
        runtime: hermesRuntimeMetadata,
    },
    state: "installed",
    hooks: {
        onLoad: (ctx) => {
            const settings = resolveCliSettings(ctx.settings);
            ctx.logger.info(`Hermes Runtime Plugin loaded — binary=${settings.binaryPath} model=${settings.model ?? "(default)"}`);
            ctx.emitEvent("hermes-runtime:loaded", {
                runtimeId: HERMES_RUNTIME_ID,
                version: HERMES_RUNTIME_VERSION,
            });
        },
        onUnload: () => {
            // No persistent state to clean up — each prompt spawns a fresh subprocess.
        },
    },
    runtime: {
        metadata: hermesRuntimeMetadata,
        factory: hermesRuntimeFactory,
    },
});
export default plugin;
// ── Public exports ────────────────────────────────────────────────────────────
export { hermesRuntimeMetadata, hermesRuntimeFactory, HERMES_RUNTIME_ID };
export { HermesRuntimeAdapter } from "./runtime-adapter.js";
export { resolveCliSettings, invokeHermesCli, buildHermesArgs, parseHermesOutput, listHermesProfiles, } from "./cli-spawn.js";
// Probe re-export for the dashboard's runtime-provider-probes façade.
export { probeHermesBinary } from "./probe.js";
//# sourceMappingURL=index.js.map