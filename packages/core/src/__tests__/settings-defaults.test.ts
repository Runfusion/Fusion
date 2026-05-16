import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS } from "../settings-schema.js";
import { resolveWorktrunkSettings, validateWorktrunkSettings } from "../worktrunk-settings.js";

describe("settings defaults invariants", () => {
  it("keeps worktrunk default off in global and project defaults", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.worktrunk.enabled).toBe(false);
    expect(DEFAULT_PROJECT_SETTINGS.worktrunk.enabled).toBe(false);
  });

  it("keeps project worktreesDir unset by default", () => {
    expect(DEFAULT_PROJECT_SETTINGS.worktreesDir).toBeUndefined();
  });

  it("resolves worktrunk as disabled when both scopes are unset or empty", () => {
    expect(resolveWorktrunkSettings(undefined, undefined).enabled).toBe(false);
    expect(resolveWorktrunkSettings({}, {}).enabled).toBe(false);
  });

  it("preserves explicit false overrides for worktrunk enabled", () => {
    expect(resolveWorktrunkSettings({ enabled: false }, undefined).enabled).toBe(false);
    expect(resolveWorktrunkSettings(undefined, { enabled: false }).enabled).toBe(false);
  });

  it("does not implicitly enable worktrunk when validating undefined", () => {
    expect(validateWorktrunkSettings(undefined)).toEqual({});
  });
});
