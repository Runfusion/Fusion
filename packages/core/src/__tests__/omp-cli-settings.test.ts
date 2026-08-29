import { describe, expect, it } from "vitest";
import type { GlobalSettings } from "../types.js";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  isGlobalSettingsKey,
} from "../config/settings-schema.js";

describe("OMP CLI global settings", () => {
  it("includes the enable toggle and binary path in GLOBAL_SETTINGS_KEYS", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("useOmpCli");
    expect(GLOBAL_SETTINGS_KEYS).toContain("ompCliBinaryPath");
  });

  it("defaults both OMP CLI settings to undefined", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.useOmpCli).toBeUndefined();
    expect(DEFAULT_GLOBAL_SETTINGS.ompCliBinaryPath).toBeUndefined();
  });

  it("recognizes omp CLI settings keys", () => {
    expect(isGlobalSettingsKey("ompCliBinaryPath")).toBe(true);
    expect(isGlobalSettingsKey("useOmpCli")).toBe(true);
  });

  it("accepts a string binary override distinct from the enable toggle", () => {
    const configured: GlobalSettings = {
      useOmpCli: false,
      ompCliBinaryPath: "/usr/local/bin/omp",
    };

    expect(configured.useOmpCli).toBe(false);
    expect(configured.ompCliBinaryPath).toBe("/usr/local/bin/omp");
  });
});
