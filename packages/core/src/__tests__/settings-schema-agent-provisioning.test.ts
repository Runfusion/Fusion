import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS, PROJECT_SETTINGS_KEYS } from "../config/settings-schema.js";
import { AGENT_PROVISIONING_APPROVAL_MODES } from "../types.js";

describe("agentProvisioning settings schema contract", () => {
  it("includes agentProvisioning key with object default", () => {
    expect(PROJECT_SETTINGS_KEYS).toContain("agentProvisioning");
    expect(DEFAULT_PROJECT_SETTINGS.agentProvisioning).toEqual({});
  });

  it("exposes valid approval mode vocabulary", () => {
    expect(AGENT_PROVISIONING_APPROVAL_MODES).toEqual(["always", "trusted-only", "never"]);
  });

  it("supports omitted block defaults", () => {
    const settings = DEFAULT_PROJECT_SETTINGS.agentProvisioning ?? {};
    expect(settings).toEqual({});
  });
});
