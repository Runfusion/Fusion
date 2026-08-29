import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@fusion/core";
import plugin from "../index.js";
import manifestJson from "../../manifest.json" with { type: "json" };

describe("cli-printing-press plugin", () => {
  it("registers with the correct manifest id", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-cli-printing-press");
  });

  it("passes manifest validation", () => {
    const validation = validatePluginManifest(manifestJson);
    expect(validation.valid).toBe(true);
  });

  it("registers the wizard and manage dashboard views", () => {
    expect(plugin.dashboardViews).toEqual([
      {
        viewId: "wizard",
        label: "Create Service CLI",
        componentPath: "./dashboard-view",
        icon: "Wand2",
        placement: "primary",
        order: 60,
      },
      {
        viewId: "manage",
        label: "Manage Service CLIs",
        componentPath: "./manage-view",
        icon: "List",
        placement: "primary",
        order: 61,
      },
    ]);
  });
});
