/**
 * Hermes Runtime Plugin
 *
 * Provides an executable Hermes runtime adapter that drives the local `hermes`
 * CLI as a subprocess. Discovered by Fusion's plugin runtime registry; the
 * settings configured in the dashboard's "Runtimes → Hermes" page flow through
 * `ctx.settings` into the CLI invocation.
 */
import type { FusionPlugin, PluginRuntimeFactory, PluginRuntimeManifestMetadata } from "@fusion/plugin-sdk";
declare const HERMES_RUNTIME_ID = "hermes";
declare const hermesRuntimeMetadata: PluginRuntimeManifestMetadata;
declare const hermesRuntimeFactory: PluginRuntimeFactory;
declare const plugin: FusionPlugin;
export default plugin;
export { hermesRuntimeMetadata, hermesRuntimeFactory, HERMES_RUNTIME_ID };
export { HermesRuntimeAdapter } from "./runtime-adapter.js";
export { resolveCliSettings, invokeHermesCli, buildHermesArgs, parseHermesOutput, listHermesProfiles, } from "./cli-spawn.js";
export type { HermesCliSettings, HermesCliResult, HermesProfileSummary } from "./cli-spawn.js";
export { probeHermesBinary } from "./probe.js";
export type { HermesBinaryStatus } from "./probe.js";
//# sourceMappingURL=index.d.ts.map