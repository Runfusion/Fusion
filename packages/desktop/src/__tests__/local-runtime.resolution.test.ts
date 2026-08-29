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
  }, 15000);

  it("can instantiate LocalRuntimeManager without relying on built dist artifacts", () => {
    const manager = new LocalRuntimeManager({ rootDir: process.cwd() });
    expect(manager.getStatus().state).toBe("stopped");
  });
});
