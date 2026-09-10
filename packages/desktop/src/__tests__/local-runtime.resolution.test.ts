import { describe, expect, it } from "vitest";
import { LocalRuntimeManager } from "../local-runtime";

describe("desktop runtime package resolution", () => {
  it("resolves @fusion/core and @fusion/dashboard from desktop vitest project", async () => {
    const core = await import("@fusion/core");
    const dashboard = await import("@fusion/dashboard");

    expect(core.TaskStore).toBeTypeOf("function");
    expect(core.Database).toBeTypeOf("function");
    expect(core.PluginStore).toBeTypeOf("function");
    expect(dashboard.createServer).toBeTypeOf("function");
    // FN-9295: Vite transforms the full dashboard (and its plugin graph) on
    // import; 15s is too aggressive on CI runners. 30s still fails fast on
    // genuine resolution errors.
  }, 30000);

  it("can instantiate LocalRuntimeManager without relying on built dist artifacts", () => {
    const manager = new LocalRuntimeManager({ rootDir: process.cwd() });
    expect(manager.getStatus().state).toBe("stopped");
  });
});
