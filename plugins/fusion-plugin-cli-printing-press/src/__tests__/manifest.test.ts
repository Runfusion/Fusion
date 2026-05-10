import { describe, it, expect } from "vitest";
import { validatePluginManifest } from "@fusion/core";
import plugin from "../index.js";
import manifestJson from "../../manifest.json" with { type: "json" };

describe("cli-printing-press plugin stub (FN-3762)", () => {
  it("registers with the correct manifest id", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-cli-printing-press");
  });

  it("passes manifest validation", () => {
    const validation = validatePluginManifest(manifestJson);
    expect(validation.valid).toBe(true);
  });

  it("has no routes or dashboardViews in the stub", () => {
    expect(plugin.routes).toBeUndefined();
    expect(plugin.dashboardViews).toBeUndefined();
  });
});
