import { describe, expect, it } from "vitest";
import { extractAgentProvisioningRequest, resolveAgentProvisioningPolicy } from "../agents/agent-provisioning-policy.js";

describe("resolveAgentProvisioningPolicy", () => {
  it("denies missing caller", () => {
    const decision = resolveAgentProvisioningPolicy({ tool: "fn_agent_create", caller: undefined, settings: undefined });
    expect(decision.decision).toBe("deny");
    expect(decision.matchedRule).toBe("missing-caller");
  });

  it("allows privileged caller", () => {
    const decision = resolveAgentProvisioningPolicy({
      tool: "fn_agent_delete",
      caller: { id: "a1", role: "executor", isPrivileged: true },
      settings: { agentProvisioning: { approvalMode: "always", alwaysApproveDelete: true } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("privileged-caller");
  });

  it("allows trusted agent id in trusted-only mode", () => {
    const decision = resolveAgentProvisioningPolicy({
      tool: "fn_agent_create",
      caller: { id: "trusted-id" },
      settings: { agentProvisioning: { approvalMode: "trusted-only", trustedAgentIds: ["trusted-id"] } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("trusted-agent-id");
  });

  it("matches trusted role case-insensitively", () => {
    const decision = resolveAgentProvisioningPolicy({
      tool: "fn_agent_create",
      caller: { id: "a1", role: "CEO" },
      settings: { agentProvisioning: { approvalMode: "trusted-only", trustedRoles: ["ceo"] } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("trusted-role");
  });

  it("requires approval for untrusted caller in trusted-only mode", () => {
    const decision = resolveAgentProvisioningPolicy({ tool: "fn_agent_create", caller: { id: "a1" }, settings: undefined });
    expect(decision.decision).toBe("require-approval");
    expect(decision.matchedRule).toBe("approval-mode-trusted-only");
    expect(decision.effectiveMode).toBe("trusted-only");
  });

  it("requires approval in always mode", () => {
    const decision = resolveAgentProvisioningPolicy({
      tool: "fn_agent_create",
      caller: { id: "a1" },
      settings: { agentProvisioning: { approvalMode: "always" } },
    });
    expect(decision.decision).toBe("require-approval");
    expect(decision.matchedRule).toBe("approval-mode-always");
  });

  it("alwaysApproveDelete forces approval by default", () => {
    const decision = resolveAgentProvisioningPolicy({
      tool: "fn_agent_delete",
      caller: { id: "trusted", role: "ceo" },
      settings: { agentProvisioning: { approvalMode: "trusted-only", trustedAgentIds: ["trusted"] } },
    });
    expect(decision.decision).toBe("require-approval");
    expect(decision.matchedRule).toBe("delete-always-approve");
  });

  it("allows trusted delete when alwaysApproveDelete is false", () => {
    const decision = resolveAgentProvisioningPolicy({
      tool: "fn_agent_delete",
      caller: { id: "trusted" },
      settings: { agentProvisioning: { approvalMode: "trusted-only", trustedAgentIds: ["trusted"], alwaysApproveDelete: false } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("trusted-agent-id");
  });

  it("never mode short-circuits delete approval", () => {
    const decision = resolveAgentProvisioningPolicy({
      tool: "fn_agent_delete",
      caller: { id: "a1" },
      settings: { agentProvisioning: { approvalMode: "never", alwaysApproveDelete: true } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("approval-mode-never");
  });
});

describe("extractAgentProvisioningRequest", () => {
  it("extracts tool and params from provisioning request", () => {
    const request: any = {
      id: "apr-1",
      targetAction: {
        category: "agent_provisioning",
        context: { tool: "fn_agent_create", params: { name: "helper" } },
      },
    };
    expect(extractAgentProvisioningRequest(request)).toEqual({ tool: "fn_agent_create", params: { name: "helper" } });
  });

  it("throws for malformed context", () => {
    const request: any = { id: "apr-1", targetAction: { category: "agent_provisioning", context: {} } };
    expect(() => extractAgentProvisioningRequest(request)).toThrow("invalid provisioning tool");
  });
});
