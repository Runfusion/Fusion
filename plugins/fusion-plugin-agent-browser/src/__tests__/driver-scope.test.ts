import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { AGENT_BROWSER_TOOLS } from "../tools.js";

// The engine exposes ONLY `plugin.tools` to coding-agent sessions
// (`pluginLoader.getPluginTools()`). The verification driver must therefore
// never appear in that array — it is reachable only via the direct
// `launchBrowserDriver` export the engine imports inside the verification run.
describe("driver scope — not exposed to coding-agent sessions", () => {
  const driverToolNames = ["browser_navigate", "browser_interact", "browser_observe", "browser_driver"];

  it("plugin.tools contains only the coding-agent metadata tool, not the driver", () => {
    const toolNames = (plugin.tools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(["browser_fetch_metadata"]);
  });

  it("AGENT_BROWSER_TOOLS does not register any navigate/interact/observe driver tool", () => {
    const names = AGENT_BROWSER_TOOLS.map((t) => t.name);
    for (const driverName of driverToolNames) {
      expect(names).not.toContain(driverName);
    }
  });

  it("the verification driver is exported as a direct capability, not a registered tool", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.launchBrowserDriver).toBe("function");
    // It is a plain function export, not surfaced through any tool registry.
    expect((plugin.tools ?? []).some((t) => t.name.includes("navigate"))).toBe(false);
  });
});
