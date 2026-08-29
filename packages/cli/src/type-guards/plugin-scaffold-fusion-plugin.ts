import type { FusionPlugin } from "@fusion/core";

function defineScaffoldPluginFixture(plugin: FusionPlugin): FusionPlugin {
  return plugin;
}

/**
 * FNXC:PluginScaffold 2026-06-14-01:48:
 * This fixture mirrors the standalone scaffold's emitted plugin object so the CLI build fails when the SDK-backed FusionPlugin contract adds a required field that `fn plugin new` must emit.
 */
const standaloneScaffoldPluginFixture: FusionPlugin = {
  manifest: {
    id: "hello-plugin",
    name: "Hello Plugin",
    version: "0.1.0",
    description: "A standalone Fusion plugin",
  },
  state: "installed",
  hooks: {
    onLoad: async (ctx) => {
      ctx.logger.info("Hello Plugin plugin loaded");
    },
  },
};

export function verifyStandaloneScaffoldPluginFixture(): FusionPlugin {
  return defineScaffoldPluginFixture(standaloneScaffoldPluginFixture);
}

export { standaloneScaffoldPluginFixture };
