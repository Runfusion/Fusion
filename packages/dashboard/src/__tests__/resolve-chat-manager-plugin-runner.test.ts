import { describe, expect, it } from "vitest";
import { resolveChatManagerPluginRunner } from "../server.js";

/*
FNXC:GrokCliRouting 2026-07-10-00:00:
Regression guard for the "grok chat not working" default-chat failure. The
default (no-project) ChatManager must receive a real PluginRunner (with
`getRuntimeById`/`createRuntimeContext`) for Grok CLI runtime resolution — a
bare PluginLoader lacks `getRuntimeById`, so `deriveGrokRuntimeHintForNoVisibleKey`
threw "getRuntimeById is not a function" → the misleading "requires the bundled
Grok CLI runtime" error. `resolveChatManagerPluginRunner` must prefer the
engine's PluginRunner and fall back to the loader only when no engine exists.
*/
describe("resolveChatManagerPluginRunner", () => {
  const bareLoader = { getPluginRoutes: () => [] };
  const engineRunner = {
    getPluginRoutes: () => [],
    getRuntimeById: () => ({ pluginId: "fusion-plugin-grok-runtime", runtime: {} }),
    createRuntimeContext: async () => ({}),
  };

  it("prefers the engine's PluginRunner over the bare loader when an engine is present", () => {
    const engine = { getPluginRunner: () => engineRunner } as never;
    const resolved = resolveChatManagerPluginRunner({
      engine,
      pluginRunner: bareLoader as never,
    });
    expect(resolved).toBe(engineRunner);
    // The chosen runner must expose runtime resolution — the exact capability
    // the bare loader lacks and that Grok CLI routing depends on.
    expect(typeof (resolved as { getRuntimeById?: unknown })?.getRuntimeById).toBe("function");
  });

  it("falls back to options.pluginRunner in UI-only mode (no engine)", () => {
    const resolved = resolveChatManagerPluginRunner({
      engine: undefined,
      pluginRunner: bareLoader as never,
    });
    expect(resolved).toBe(bareLoader);
  });

  it("falls back to options.pluginRunner when the engine exposes no runner", () => {
    const engine = { getPluginRunner: () => undefined } as never;
    const resolved = resolveChatManagerPluginRunner({
      engine,
      pluginRunner: bareLoader as never,
    });
    expect(resolved).toBe(bareLoader);
  });
});
