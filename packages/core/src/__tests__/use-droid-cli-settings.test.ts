import { describe, expect, it } from "vitest";
import type { GlobalSettings } from "../types.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
} from "../config/settings-schema.js";

describe("useDroidCli global setting", () => {
  it("is included in GLOBAL_SETTINGS_KEYS", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("useDroidCli");
  });

  it("defaults to undefined", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.useDroidCli).toBeUndefined();
  });

  it("is recognized by isGlobalSettingsKey", () => {
    expect(isGlobalSettingsKey("useDroidCli")).toBe(true);
  });

  it("accepts boolean values in GlobalSettings", () => {
    const enabled: GlobalSettings = { useDroidCli: true };
    const disabled: GlobalSettings = { useDroidCli: false };
    expect(enabled.useDroidCli).toBe(true);
    expect(disabled.useDroidCli).toBe(false);
  });
});
