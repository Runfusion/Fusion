import { describe, expectTypeOf, it } from "vitest";
import type {
  FusionPlugin,
  PluginInstallation,
  PluginSetupHooks,
  PluginSetupManifest,
  PluginState,
} from "../index.js";

describe("plugin-sdk re-export contract", () => {
  it("re-exports the plugin-setup and lifecycle types from @fusion/core", () => {
    expectTypeOf<PluginSetupHooks>().not.toBeAny();
    expectTypeOf<PluginSetupManifest>().not.toBeAny();
    expectTypeOf<FusionPlugin>().not.toBeAny();
    expectTypeOf<PluginState>().not.toBeAny();
    expectTypeOf<PluginInstallation>().not.toBeAny();
  });
});
