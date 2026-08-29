import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@fusion/plugin-sdk";
import plugin, { droidRuntimeMetadata, DROID_RUNTIME_ID } from "../index.js";

describe("droid runtime plugin index", () => {
  it("exports expected manifest/runtime metadata", () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-droid-runtime");
    expect(droidRuntimeMetadata.runtimeId).toBe("droid");
    expect(DROID_RUNTIME_ID).toBe("droid");
  });

  it("registers required ui slots", () => {
    const slots = plugin.uiSlots?.map((s) => s.slotId) ?? [];
    expect(slots).toEqual(expect.arrayContaining([
      "settings-provider-card",
      "settings-integration-card",
      "onboarding-provider-card",
      "onboarding-setup-help",
      "post-onboarding-recommendation",
    ]));
  });

  it("locks droid settings slot registration shape", () => {
    const settingsSlot = plugin.uiSlots?.find((slot) => slot.slotId === "settings-provider-card");
    expect(settingsSlot).toMatchObject({
      slotId: "settings-provider-card",
      label: "Droid CLI Provider",
      componentPath: "./components/settings-provider-card.js",
      order: 10,
    });
  });

  it("has a valid manifest", () => {
    expect(() => validatePluginManifest(plugin.manifest)).not.toThrow();
  });
});
