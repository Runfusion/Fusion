import { describe, expect, it } from "vitest";
import type { GlobalSettings } from "../types.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
} from "../config/settings-schema.js";

describe("Cursor CLI global settings", () => {
  it("includes the enable toggle and binary path in GLOBAL_SETTINGS_KEYS", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("useCursorCli");
    expect(GLOBAL_SETTINGS_KEYS).toContain("cursorCliBinaryPath");
  });

  it("defaults both Cursor CLI settings to undefined", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.useCursorCli).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.cursorCliBinaryPath).toBeUndefined();
  });

  it("recognizes cursorCliBinaryPath as a global settings key", () => {
    expect(isGlobalSettingsKey("cursorCliBinaryPath")).toBe(true);
    expect(isGlobalSettingsKey("useCursorCli")).toBe(true);
  });

  it("accepts a string binary override distinct from the enable toggle", () => {
    const configured: GlobalSettings = {
      useCursorCli: false,
      cursorCliBinaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd",
    };

    expect(configured.useCursorCli).toBe(false);
    expect(configured.cursorCliBinaryPath).toBe("C:\\Users\\A User\\AppData\\Roaming\\npm\\cursor-agent.cmd");
  });
});
