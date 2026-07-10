import { describe, expect, it } from "vitest";
import {
  isPolicyBroaderThanDefault,
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
      toolRules: { fn_task_create: "block" },
    });

    expect(policy.presetId).toBe("custom");
    expect(policy.rules.network_api).toBe("block");
    expect(policy.rules.git_write).toBe("allow");
    expect(policy.toolRules).toEqual({ fn_task_create: "block" });
  });

  it("keeps per-agent custom rule over project default", () => {
    const policy = resolveEffectiveAgentPermissionPolicy(
      {
        presetId: "custom",
        rules: { command_execution: "allow" },
      },
      { rules: { command_execution: "require-approval" }, toolRules: { fn_task_create: "block" } },
    );

    expect(policy.rules.command_execution).toBe("allow");
    expect(policy.toolRules).toBeUndefined();
  });

  it("keeps per-agent exact tool override over category defaults", () => {
    const policy = resolveEffectiveAgentPermissionPolicy({
      presetId: "custom",
      rules: { task_agent_mutation: "allow" },
      toolRules: { fn_task_create: "block" },
    });

    expect(policy.rules.task_agent_mutation).toBe("allow");
    expect(policy.toolRules?.fn_task_create).toBe("block");
  });

  it("rejects invalid disposition values", () => {
    expect(() =>
      normalizeAgentPermissionPolicy({
        presetId: "custom",
        rules: { git_write: "nope" as never },
      }),
    ).toThrow(/Invalid permission policy disposition/);
  });

  it("rejects invalid exact tool dispositions and blank names", () => {
    expect(() =>
      normalizeAgentPermissionPolicy({
        presetId: "custom",
        toolRules: { fn_task_create: "nope" as never },
      }),
    ).toThrow(/toolRules\.fn_task_create has invalid disposition/);

    expect(() =>
      normalizeAgentPermissionPolicy({
        presetId: "custom",
        toolRules: { " ": "block" },
      }),
    ).toThrow(/blank tool name/);
  });

  it("detects broader-than-default exact tool escalation", () => {
    const defaultPolicy = resolveEffectiveAgentPermissionPolicy(undefined, {
      rules: { task_agent_mutation: "allow" },
      toolRules: { fn_task_create: "block" },
    });
    const agentPolicy = resolveEffectiveAgentPermissionPolicy({
      presetId: "custom",
      rules: { task_agent_mutation: "allow" },
    });

    expect(isPolicyBroaderThanDefault(agentPolicy, defaultPolicy)).toBe(true);
  });

  it("does not flag exact tool overrides that are no broader than the project default", () => {
    const defaultPolicy = resolveEffectiveAgentPermissionPolicy(undefined, {
      toolRules: { fn_task_create: "require-approval" },
    });
    const agentPolicy = resolveEffectiveAgentPermissionPolicy({
      presetId: "custom",
      rules: { task_agent_mutation: "block" },
    });

    expect(isPolicyBroaderThanDefault(agentPolicy, defaultPolicy)).toBe(false);
  });

  // FN-7737: file_scope escalation regression coverage.
  it("detects a file_scope escalation when an agent sets allow over a stricter project default", () => {
    const defaultPolicy = resolveEffectiveAgentPermissionPolicy(undefined, {
      rules: { file_scope: "require-approval" },
    });
    const agentPolicy = resolveEffectiveAgentPermissionPolicy({
      presetId: "custom",
      rules: { file_scope: "allow" },
    });

    expect(isPolicyBroaderThanDefault(agentPolicy, defaultPolicy)).toBe(true);
  });
});
