import { describe, expect, it } from "vitest";
import {
  normalizeAgentPermissionPolicy,
  resolveEffectiveAgentPermissionPolicy,
  resolveAgentPermissionPolicyPreset,
} from "../agent-permission-policy.js";

describe("agent permission policy resolution", () => {
  it("returns built-in preset rules unchanged", () => {
    const policy = resolveEffectiveAgentPermissionPolicy({
      presetId: "locked-down",
      rules: resolveAgentPermissionPolicyPreset("unrestricted").rules,
    });

    expect(policy.presetId).toBe("locked-down");
    expect(policy.rules).toEqual(resolveAgentPermissionPolicyPreset("locked-down").rules);
  });

  it("merges custom preset overrides over unrestricted seed", () => {
    const policy = normalizeAgentPermissionPolicy({
      presetId: "custom",
      rules: { command_execution: "require-approval" },
    });

    expect(policy.rules.command_execution).toBe("require-approval");
    expect(policy.rules.git_write).toBe("allow");
  });

  it("uses project default when agent policy is undefined", () => {
    const policy = resolveEffectiveAgentPermissionPolicy(undefined, {
      rules: { network_api: "block" },
    });

    expect(policy.presetId).toBe("custom");
    expect(policy.rules.network_api).toBe("block");
    expect(policy.rules.git_write).toBe("allow");
  });

  it("keeps per-agent custom rule over project default", () => {
    const policy = resolveEffectiveAgentPermissionPolicy(
      {
        presetId: "custom",
        rules: { command_execution: "allow" },
      },
      { rules: { command_execution: "require-approval" } },
    );

    expect(policy.rules.command_execution).toBe("allow");
  });

  it("rejects invalid disposition values", () => {
    expect(() =>
      normalizeAgentPermissionPolicy({
        presetId: "custom",
        rules: { git_write: "nope" as never },
      }),
    ).toThrow(/Invalid permission policy disposition/);
  });
});
