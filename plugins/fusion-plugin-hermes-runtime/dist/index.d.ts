/**
 * Hermes Runtime Plugin
 *
 * Provides an executable Hermes runtime adapter for Fusion's plugin runtime
 * discovery and session execution pipeline.
 */
import type { FusionPlugin, PluginRuntimeFactory, PluginRuntimeManifestMetadata } from "@fusion/plugin-sdk";
declare const HERMES_RUNTIME_ID = "hermes";
declare const hermesRuntimeMetadata: PluginRuntimeManifestMetadata;
declare const hermesRuntimeFactory: PluginRuntimeFactory;
declare const plugin: FusionPlugin;
export default plugin;
export { hermesRuntimeMetadata, hermesRuntimeFactory, HERMES_RUNTIME_ID };
//# sourceMappingURL=index.d.ts.map