import { describe, expect, it } from "vitest";
import type { GlobalSettings } from "../types.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
} from "../settings-schema.js";

describe("useLlamaCpp global setting", () => {
  it("is included in GLOBAL_SETTINGS_KEYS", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("useLlamaCpp");
  });

  it("defaults to undefined", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.useLlamaCpp).toBeUndefined();
  });

  it("is recognized by isGlobalSettingsKey", () => {
    expect(isGlobalSettingsKey("useLlamaCpp")).toBe(true);
  });

  it("accepts boolean values in GlobalSettings", () => {
    const enabled: GlobalSettings = { useLlamaCpp: true };
    const disabled: GlobalSettings = { useLlamaCpp: false };
    expect(enabled.useLlamaCpp).toBe(true);
    expect(disabled.useLlamaCpp).toBe(false);
  });
});
