import { describe, expect, it } from "vitest";
import { AGENT_PERMISSION_POLICY_ACTION_CATEGORIES, resolveEffectiveAgentPermissionPolicy, type AgentPermissionPolicyRules } from "@fusion/core";
import { evaluateAgentActionGate } from "../agent-action-gate.js";

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
      evaluateAgentActionGate({ agentId: "a1", toolName: "fn_web_fetch", args: { url: "https://example.com" }, permissionPolicy }),
      evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_add_dep", args: { task_id: "FN-1" }, permissionPolicy }),
    ];

    for (const decision of decisions) {
      if (decision.category === "exempt") {
        continue;
      }
      expect(decision.disposition).toBe("require-approval");
    }
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
});
