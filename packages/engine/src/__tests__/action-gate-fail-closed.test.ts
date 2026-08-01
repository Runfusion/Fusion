import { describe, expect, it } from "vitest";
import {
  configureApprovalRequestTtls,
  normalizeAgentPermissionPolicyFromPreset,
} from "@fusion/core";
import { evaluateAgentActionGate, resolveGateOutcome } from "../agent-action-gate.js";
import { resolvePermanentAgentToolDecision } from "../permanent-agent-gating.js";

/*
FNXC:AgentGating 2026-07-26-14:10:
Both-directions regression tests for the fail-closed audit fixes:
 1) unclassified tools no longer resolve to hardcoded exempt/allow — they are
    policy-governed (unchanged under the default `unrestricted` preset,
    actually blocked under `locked-down`);
 2) bash approvals bind to the exact command via a hashed resourceId in the
    dedupe key;
 3) approved-but-unredeemed grants expire (grant TTL) at redemption;
 4) a permanent-gating context with a wholly missing policy fails closed.
Expectations are HARDCODED, never derived from the constants under test.
*/

const UNRESTRICTED = normalizeAgentPermissionPolicyFromPreset("unrestricted");
const LOCKED_DOWN = normalizeAgentPermissionPolicyFromPreset("locked-down");

describe("evaluateAgentActionGate — unclassified tools are policy-governed (fail closed)", () => {
  it("default unrestricted preset: unknown tool still allowed (behavior unchanged)", () => {
    const decision = evaluateAgentActionGate({
      agentId: "agent-1",
      toolName: "fn_some_future_tool",
      args: {},
      permissionPolicy: UNRESTRICTED,
    });
    expect(decision.disposition).toBe("allow");
    expect(decision.category).toBe("command_execution");
  });

  it("locked-down preset: unknown tool is blocked (was exempt/allow before the fix)", () => {
    const decision = evaluateAgentActionGate({
      agentId: "agent-1",
      toolName: "fn_some_future_tool",
      args: {},
      permissionPolicy: LOCKED_DOWN,
    });
    expect(decision.disposition).toBe("block");
    expect(decision.category).toBe("command_execution");
  });

  it("registered coordination tools stay exempt in both presets", () => {
    for (const policy of [UNRESTRICTED, LOCKED_DOWN]) {
      const decision = evaluateAgentActionGate({
        agentId: "agent-1",
        toolName: "fn_heartbeat_done",
        args: {},
        permissionPolicy: policy,
      });
      expect(decision.disposition).toBe("allow");
      expect(decision.category).toBe("exempt");
    }
  });
});

describe("evaluateAgentActionGate — bash approvals bind to the exact command", () => {
  it("two different shell commands produce different dedupe keys", () => {
    const base = { agentId: "agent-1", taskId: "FN-1", toolName: "bash", permissionPolicy: UNRESTRICTED };
    const a = evaluateAgentActionGate({ ...base, args: { command: "echo hello" } });
    const b = evaluateAgentActionGate({ ...base, args: { command: "rm -rf build" } });
    expect(a.approvalDedupeKey).not.toBe(b.approvalDedupeKey);
    expect(a.resourceId).toMatch(/^cmd:[0-9a-f]{16}$/);
    expect(b.resourceId).toMatch(/^cmd:[0-9a-f]{16}$/);
  });

  it("the same command produces a stable dedupe key", () => {
    const base = { agentId: "agent-1", taskId: "FN-1", toolName: "bash", permissionPolicy: UNRESTRICTED };
    const a = evaluateAgentActionGate({ ...base, args: { command: "pnpm test" } });
    const b = evaluateAgentActionGate({ ...base, args: { command: "pnpm test" } });
    expect(a.approvalDedupeKey).toBe(b.approvalDedupeKey);
  });

  it("git write commands are also command-bound", () => {
    const base = { agentId: "agent-1", toolName: "bash", permissionPolicy: UNRESTRICTED };
    const push = evaluateAgentActionGate({ ...base, args: { command: "git push origin main" } });
    const pushForce = evaluateAgentActionGate({ ...base, args: { command: "git push --force origin main" } });
    expect(push.category).toBe("git_write");
    expect(push.approvalDedupeKey).not.toBe(pushForce.approvalDedupeKey);
  });
});

describe("resolveGateOutcome — approval-grant TTL at redemption", () => {
  const decision = {
    disposition: "require-approval" as const,
    category: "command_execution" as const,
    toolName: "bash",
    operation: "shell command",
    summary: "bash: shell command",
    resourceType: "command" as const,
    approvalDedupeKey: "k",
    metadata: {},
  };

  it("fresh approved grant redeems execute-once", () => {
    const outcome = resolveGateOutcome(decision, {
      id: "apr-1",
      status: "approved",
      decidedAt: new Date().toISOString(),
    });
    expect(outcome.outcome).toBe("execute-once-then-complete");
    expect(outcome.approvalRequestId).toBe("apr-1");
  });

  it("stale approved grant (past the configured grant TTL) is treated as absent", () => {
    /*
    FNXC:ApprovalRedemption 2026-07-26-19:05:
    The grant TTL is operator-configurable (configureApprovalRequestTtls /
    FUSION_APPROVAL_GRANT_TTL_MS, default 1h). Pin it explicitly for this test so
    the expectation cannot silently drift with the default.
    */
    configureApprovalRequestTtls({ grantTtlMs: 15 * 60 * 1000 });
    try {
      const outcome = resolveGateOutcome(decision, {
        id: "apr-1",
        status: "approved",
        decidedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      });
      expect(outcome).toEqual({ outcome: "wait-for-approval" });
    } finally {
      configureApprovalRequestTtls({ grantTtlMs: undefined });
    }
  });

  it("closures that omit decidedAt keep legacy redemption (backward compatible)", () => {
    const outcome = resolveGateOutcome(decision, { id: "apr-1", status: "approved" });
    expect(outcome.outcome).toBe("execute-once-then-complete");
  });
});

describe("resolvePermanentAgentToolDecision — missing policy fails closed", () => {
  it("sensitive tool with a policy-less gating context requires approval (was allow)", () => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "fn_task_delete",
      args: {},
      gating: {} as never,
    });
    expect(decision.disposition).toBe("require-approval");
  });

  it("recognized coordination tool stays allowed even with a policy-less context", () => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "fn_heartbeat_done",
      args: {},
      gating: {} as never,
    });
    expect(decision.disposition).toBe("allow");
  });

  it("with the default unrestricted policy, sensitive tools remain allowed (behavior unchanged)", () => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "fn_task_delete",
      args: {},
      gating: { permissionPolicy: UNRESTRICTED } as never,
    });
    expect(decision.disposition).toBe("allow");
  });
});
