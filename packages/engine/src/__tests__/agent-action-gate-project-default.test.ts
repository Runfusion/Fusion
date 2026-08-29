import { describe, expect, it } from "vitest";
import { AGENT_PERMISSION_POLICY_ACTION_CATEGORIES, resolveEffectiveAgentPermissionPolicy, type AgentPermissionPolicyRules } from "@fusion/core";
import { evaluateAgentActionGate } from "../agents/agent-action-gate.js";

describe("agent action gate project-default resolution", () => {
  it("applies project default rules when agent policy is undefined", () => {
    const requireApprovalRules = AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.reduce((acc, category) => {
      acc[category] = "require-approval";
      return acc;
    }, {} as Partial<AgentPermissionPolicyRules>);

    const permissionPolicy = resolveEffectiveAgentPermissionPolicy(undefined, {
      rules: requireApprovalRules,
    });

    const decisions = [
      evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git commit -m x" }, permissionPolicy }),
      evaluateAgentActionGate({ agentId: "a1", toolName: "write", args: { path: "x.ts", content: "x" }, permissionPolicy }),
      evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "pnpm test" }, permissionPolicy }),
      evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_add_dep", args: { task_id: "FN-1" }, permissionPolicy }),
    ];

    for (const decision of decisions) {
      expect(decision.disposition).toBe("require-approval");
    }

    const webFetchDecision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_web_fetch",
      args: { url: "https://example.com" },
      permissionPolicy,
    });

    expect(webFetchDecision.category).toBe("network_api");
    expect(webFetchDecision.disposition).toBe("require-approval");
  });

  it.each([
    ["allow", "allow"],
    ["block", "block"],
    ["require-approval", "require-approval"],
  ] as const)("routes fn_web_fetch through network_api policy (%s)", (networkDisposition, expected) => {
    const permissionPolicy = resolveEffectiveAgentPermissionPolicy(undefined, {
      rules: { network_api: networkDisposition },
    });

    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_web_fetch",
      args: { url: "https://example.com" },
      permissionPolicy,
    });

    expect(decision.category).toBe("network_api");
    expect(decision.disposition).toBe(expected);
  });

  it("keeps per-agent custom rule over project default", () => {
    const permissionPolicy = resolveEffectiveAgentPermissionPolicy(
      {
        presetId: "custom",
        rules: {
          git_write: "allow",
          file_write_delete: "allow",
          command_execution: "allow",
          network_api: "allow",
          task_agent_mutation: "allow",
        },
      },
      { rules: { command_execution: "require-approval" } },
    );

    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "bash",
      args: { command: "pnpm test" },
      permissionPolicy,
    });

    expect(decision.disposition).toBe("allow");
  });

  it("applies project default exact tool override before its category rule", () => {
    const permissionPolicy = resolveEffectiveAgentPermissionPolicy(undefined, {
      rules: { task_agent_mutation: "allow" },
      toolRules: { fn_task_create: "block" },
    });

    expect(evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_task_create",
      args: {},
      permissionPolicy,
    })).toMatchObject({
      category: "task_agent_mutation",
      disposition: "block",
      metadata: {
        permissionPolicyMatch: {
          type: "toolRule",
          toolName: "fn_task_create",
          disposition: "block",
        },
      },
    });
    expect(evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_task_update",
      args: {},
      permissionPolicy,
    })).toMatchObject({
      category: "task_agent_mutation",
      disposition: "allow",
      metadata: {},
    });
  });
});
