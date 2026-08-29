import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADVANCED_SETTINGS_SECTION_IDS } from "../../SettingsModal";
import { SETTINGS_SECTION_METADATA } from "../../../../src/shared/settings-sections";

/**
 * The Voice Input nav entry must remain a Basic-mode setting. The modal's
 * visibility filter is driven solely by ADVANCED_SETTINGS_SECTION_IDS, while
 * this contract also protects the matching render-switch case.
 *
 * FNXC:UiMetadataApi 2026-07-14-00:00: the nav entry itself now lives in the
 * shared settings-sections registry that drives both Settings and
 * GET /api/settings/sections, so the entry is asserted against the registry
 * rather than grepped out of SettingsModal.tsx.
 */
describe("Voice Input SettingsModal visibility", () => {
  it("keeps Voice Input visible outside Advanced settings and wires its render case", () => {
    expect(ADVANCED_SETTINGS_SECTION_IDS.has("voice-input")).toBe(false);
    expect(SETTINGS_SECTION_METADATA.find((section) => section.id === "voice-input")).toMatchObject({
      label: "Voice Input",
      labelKey: "settings.nav.voiceInput",
      scope: "project",
      advanced: false,
    });
    const modalSource = readFileSync(resolve(__dirname, "../../SettingsModal.tsx"), "utf8");
    expect(modalSource).toContain('case "voice-input":');
    expect(modalSource).toContain("<VoiceInputSection form={form} setForm={setForm} />");
  });
});
