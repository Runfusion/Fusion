import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS, PROJECT_SETTINGS_KEYS } from "../settings-schema.js";

describe("defaultAgentPermissionPolicy settings schema contract", () => {
  it("includes defaultAgentPermissionPolicy key", () => {
    expect(PROJECT_SETTINGS_KEYS).toContain("defaultAgentPermissionPolicy");
  });

  it("defaults to undefined", () => {
    expect(DEFAULT_PROJECT_SETTINGS.defaultAgentPermissionPolicy).toBeUndefined();
  });

  it("supports partial category rules", () => {
    const setting = {
      rules: {
        command_execution: "require-approval",
      },
    };

    expect(setting.rules.command_execution).toBe("require-approval");
  });
});
