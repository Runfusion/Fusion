/**
 * OpenClaw Runtime Plugin
 *
 * Provides an executable OpenClaw runtime adapter for Fusion's plugin runtime
 * discovery and session execution pipeline.
 */
import type { FusionPlugin, PluginRuntimeFactory, PluginRuntimeManifestMetadata } from "@fusion/plugin-sdk";
declare const OPENCLAW_RUNTIME_ID = "openclaw";
declare const openclawRuntimeMetadata: PluginRuntimeManifestMetadata;
declare const openclawRuntimeFactory: PluginRuntimeFactory;
declare const plugin: FusionPlugin;
export default plugin;
export { openclawRuntimeMetadata, openclawRuntimeFactory, OPENCLAW_RUNTIME_ID };
//# sourceMappingURL=index.d.ts.map