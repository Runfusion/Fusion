/**
 * OpenClaw Runtime Plugin
 *
 * Drives the local `openclaw` CLI as a subprocess (via
 * `openclaw --no-color agent --local --json`). No daemon required.
 */
import type { FusionPlugin, PluginRuntimeFactory, PluginRuntimeManifestMetadata } from "@fusion/plugin-sdk";
declare const OPENCLAW_RUNTIME_ID = "openclaw";
declare const openclawRuntimeMetadata: PluginRuntimeManifestMetadata;
declare const openclawRuntimeFactory: PluginRuntimeFactory;
declare const plugin: FusionPlugin;
export default plugin;
export { openclawRuntimeMetadata, openclawRuntimeFactory, OPENCLAW_RUNTIME_ID };
export { OpenClawRuntimeAdapter } from "./runtime-adapter.js";
export { resolveCliConfig, buildOpenClawArgs, createCliSession, promptCli, describeCliModel, extractStderrError, } from "./pi-module.js";
export type { CliConfig, GatewaySession, OpenClawAgentJson } from "./types.js";
export { probeOpenClawBinary } from "./probe.js";
export type { OpenClawBinaryStatus } from "./probe.js";
//# sourceMappingURL=index.d.ts.map