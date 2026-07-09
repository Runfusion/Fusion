import { describe, expect, it } from "vitest";
import type { GlobalSettings } from "../types.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
} from "../settings-schema.js";

describe("Grok CLI global settings", () => {
  it("includes the enable toggle and binary path in GLOBAL_SETTINGS_KEYS", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("useGrokCli");
    expect(GLOBAL_SETTINGS_KEYS).toContain("grokCliBinaryPath");
  });

  it("defaults both Grok CLI settings to undefined", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.useGrokCli).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.grokCliBinaryPath).toBeUndefined();
  });

  it("recognizes grokCliBinaryPath as a global settings key", () => {
    expect(isGlobalSettingsKey("grokCliBinaryPath")).toBe(true);
    expect(isGlobalSettingsKey("useGrokCli")).toBe(true);
  });

  it("accepts a string binary override distinct from the enable toggle", () => {
    const configured: GlobalSettings = {
      useGrokCli: false,
      grokCliBinaryPath: "C:\\Users\\A User\\AppData\\Roaming\\npm\\grok.cmd",
    };

    expect(configured.useGrokCli).toBe(false);
    expect(configured.grokCliBinaryPath).toBe("C:\\Users\\A User\\AppData\\Roaming\\npm\\grok.cmd");
  });
});
