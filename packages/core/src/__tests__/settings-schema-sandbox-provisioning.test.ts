import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS, PROJECT_SETTINGS_KEYS } from "../config/settings-schema.js";
import { SANDBOX_PROVISIONING_APPROVAL_MODES } from "../types.js";

describe("sandboxProvisioning settings schema contract", () => {
  it("includes sandboxProvisioning key with object default", () => {
    expect(PROJECT_SETTINGS_KEYS).toContain("sandboxProvisioning");
    expect(DEFAULT_PROJECT_SETTINGS.sandboxProvisioning).toEqual({});
  });

  it("exposes valid approval mode vocabulary", () => {
    expect(SANDBOX_PROVISIONING_APPROVAL_MODES).toEqual(["always", "trusted-only", "never"]);
  });

  it("supports omitted block defaults", () => {
    const settings = DEFAULT_PROJECT_SETTINGS.sandboxProvisioning ?? {};
    expect(settings).toEqual({});
  });
});
