import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS, PROJECT_SETTINGS_KEYS } from "../config/settings-schema.js";

describe("defaultAgentPermissionPolicy settings schema contract", () => {
  it("includes defaultAgentPermissionPolicy key", () => {
    expect(PROJECT_SETTINGS_KEYS).toContain("defaultAgentPermissionPolicy");
  });

  it("defaults to undefined", () => {
    expect(DEFAULT_PROJECT_SETTINGS.defaultAgentPermissionPolicy).toBeUndefined();
  });

  it("supports partial category rules and exact tool overrides", () => {
    const setting = {
      rules: {
        command_execution: "require-approval",
      },
      toolRules: {
        fn_task_create: "block",
      },
    };

    expect(setting.rules.command_execution).toBe("require-approval");
    expect(setting.toolRules.fn_task_create).toBe("block");
  });
});
