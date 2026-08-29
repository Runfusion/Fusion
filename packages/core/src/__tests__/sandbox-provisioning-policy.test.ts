import { describe, expect, it } from "vitest";
import { extractSandboxProvisioningRequest, resolveSandboxProvisioningPolicy } from "../sandbox/sandbox-provisioning-policy.js";

describe("resolveSandboxProvisioningPolicy", () => {
  it("denies missing caller", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "bubblewrap",
      operation: "install",
      caller: undefined,
      settings: undefined,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.matchedRule).toBe("missing-caller");
  });

  it("allows auto-approved backend id", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "native",
      operation: "prepare",
      caller: { id: "agent-1" },
      settings: undefined,
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("auto-approve-backend");
  });

  it("allows privileged caller", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "bubblewrap",
      operation: "install",
      caller: { id: "user-1", isPrivileged: true },
      settings: { sandboxProvisioning: { approvalMode: "always" } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("privileged-caller");
  });

  it("allows trusted agent id", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "bubblewrap",
      operation: "install",
      caller: { id: "trusted-id" },
      settings: { sandboxProvisioning: { approvalMode: "trusted-only", trustedAgentIds: ["trusted-id"] } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("trusted-agent-id");
  });

  it("allows trusted role", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "bubblewrap",
      operation: "install",
      caller: { id: "agent-1", role: "CEO" },
      settings: { sandboxProvisioning: { approvalMode: "trusted-only", trustedRoles: ["ceo"] } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("trusted-role");
  });

  it("requires approval in always mode", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "bubblewrap",
      operation: "install",
      caller: { id: "agent-1" },
      settings: { sandboxProvisioning: { approvalMode: "always" } },
    });
    expect(decision.decision).toBe("require-approval");
    expect(decision.matchedRule).toBe("approval-mode-always");
  });

  it("defaults to always mode", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "bubblewrap",
      operation: "install",
      caller: { id: "agent-1" },
      settings: undefined,
    });
    expect(decision.decision).toBe("require-approval");
    expect(decision.effectiveMode).toBe("always");
  });

  it("allows never mode", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "bubblewrap",
      operation: "install",
      caller: { id: "agent-1" },
      settings: { sandboxProvisioning: { approvalMode: "never" } },
    });
    expect(decision.decision).toBe("allow");
    expect(decision.matchedRule).toBe("approval-mode-never");
  });

  it("supports unknown backend ids by requiring approval", () => {
    const decision = resolveSandboxProvisioningPolicy({
      backendId: "unknown-backend",
      operation: "custom-bootstrap",
      caller: { id: "agent-1" },
      settings: undefined,
    });
    expect(decision.decision).toBe("require-approval");
  });
});

describe("extractSandboxProvisioningRequest", () => {
  it("extracts backendId, operation, and params", () => {
    const request: any = {
      id: "apr-1",
      targetAction: {
        category: "sandbox_provisioning",
        context: { backendId: "bubblewrap", operation: "install", params: { packageName: "bubblewrap" } },
      },
    };
    expect(extractSandboxProvisioningRequest(request)).toEqual({
      backendId: "bubblewrap",
      operation: "install",
      params: { packageName: "bubblewrap" },
    });
  });

  it("throws on wrong category", () => {
    const request: any = { id: "apr-1", targetAction: { category: "agent_provisioning", context: {} } };
    expect(() => extractSandboxProvisioningRequest(request)).toThrow("not a sandbox_provisioning request");
  });

  it("throws for malformed context", () => {
    const request: any = { id: "apr-1", targetAction: { category: "sandbox_provisioning", context: {} } };
    expect(() => extractSandboxProvisioningRequest(request)).toThrow("invalid provisioning backend id");
  });
});
