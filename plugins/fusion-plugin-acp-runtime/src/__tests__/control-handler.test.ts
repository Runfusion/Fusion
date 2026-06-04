// U5 security-floor tests for the PURE permission resolver.
//
// Each `it` is a security assertion. Do NOT weaken these to go green — if one
// fails, the implementation is wrong, not the test.

import { describe, it, expect, vi } from "vitest";
import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import {
  classifyToolKind,
  selectOption,
  resolvePermission,
  DENY,
} from "../control-handler.js";
import type { GateDisposition, PermissionGate } from "../types.js";

// A full option set the agent might offer (includes the dangerous *_always).
const ALL_OPTIONS: PermissionOption[] = [
  { optionId: "allow_once_id", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always_id", name: "Allow always", kind: "allow_always" },
  { optionId: "reject_once_id", name: "Reject once", kind: "reject_once" },
  { optionId: "reject_always_id", name: "Reject always", kind: "reject_always" },
];

function toolCall(kind: ToolKind | null | undefined, extra: Partial<ToolCallUpdate> = {}): ToolCallUpdate {
  return { toolCallId: "tc-1", kind, ...extra } as ToolCallUpdate;
}

function gateWithRules(rules: Record<string, GateDisposition>, extra: Partial<PermissionGate> = {}): PermissionGate {
  return { permissionPolicy: { rules }, ...extra };
}

/** The shipped `unrestricted` default: every category → allow. */
const UNRESTRICTED: Record<string, GateDisposition> = {
  git_write: "allow",
  file_write_delete: "allow",
  command_execution: "allow",
  network_api: "allow",
  task_agent_mutation: "allow",
};

function selectedId(res: RequestPermissionResponse): string | undefined {
  return res.outcome.outcome === "selected" ? res.outcome.optionId : undefined;
}

describe("classifyToolKind", () => {
  it("maps execute → command_execution", () => {
    expect(classifyToolKind("execute")).toBe("command_execution");
  });
  it("maps edit/delete/move → file_write_delete", () => {
    expect(classifyToolKind("edit")).toBe("file_write_delete");
    expect(classifyToolKind("delete")).toBe("file_write_delete");
    expect(classifyToolKind("move")).toBe("file_write_delete");
  });
  it("maps fetch → network_api", () => {
    expect(classifyToolKind("fetch")).toBe("network_api");
  });
  it("maps read/search/think/switch_mode → exempt", () => {
    expect(classifyToolKind("read")).toBe("exempt");
    expect(classifyToolKind("search")).toBe("exempt");
    expect(classifyToolKind("think")).toBe("exempt");
    expect(classifyToolKind("switch_mode")).toBe("exempt");
  });
  it("maps other/undefined/null/unknown → DENY sentinel", () => {
    expect(classifyToolKind("other")).toBe(DENY);
    expect(classifyToolKind(undefined)).toBe(DENY);
    expect(classifyToolKind(null)).toBe(DENY);
    expect(classifyToolKind("totally_made_up" as ToolKind)).toBe(DENY);
  });
});

describe("selectOption — allow_once ONLY (S2)", () => {
  it("allow selects allow_once, never allow_always", () => {
    const sel = selectOption("allow", ALL_OPTIONS);
    expect(sel).toEqual({ decision: "allow", optionId: "allow_once_id" });
  });
  it("allow with NO allow_once falls back to reject (never allow_always)", () => {
    const noAllowOnce = ALL_OPTIONS.filter((o) => o.kind !== "allow_once");
    const sel = selectOption("allow", noAllowOnce);
    expect(sel.decision).toBe("deny");
    expect(sel.optionId).not.toBe("allow_always_id");
    expect(sel.optionId).toBe("reject_once_id");
  });
  it("deny selects reject_once, never reject_always", () => {
    const sel = selectOption("deny", ALL_OPTIONS);
    expect(sel).toEqual({ decision: "deny", optionId: "reject_once_id" });
  });
  it("deny with no reject_once leaves optionId undefined (→ cancelled)", () => {
    const onlyAllow: PermissionOption[] = [
      { optionId: "allow_once_id", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always_id", name: "Allow always", kind: "allow_always" },
    ];
    const sel = selectOption("deny", onlyAllow);
    expect(sel.decision).toBe("deny");
    expect(sel.optionId).toBeUndefined();
  });
});

describe("resolvePermission — the security floor", () => {
  // [Risk S1] per-category honored, NOT preset-allowed.
  it("blocks an execute call when command_execution is custom-blocked even under an otherwise-unrestricted policy", async () => {
    const gate = gateWithRules({ ...UNRESTRICTED, command_execution: "block" });
    const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);
    expect(res.outcome.outcome).toBe("selected");
    expect(selectedId(res)).toBe("reject_once_id");
  });

  // [Risk S2] allow → allow_once, allow_always NEVER selected.
  // (acknowledged: with allowUnrestricted the S1 escalation is off, so the allow
  // disposition reaches option selection — the point of this test.)
  it("selects allow_once for an allow category and never allow_always even when offered", async () => {
    const gate = gateWithRules({ ...UNRESTRICTED, command_execution: "allow" });
    const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate, {
      allowUnrestricted: true,
    });
    expect(selectedId(res)).toBe("allow_once_id");
    expect(selectedId(res)).not.toBe("allow_always_id");
  });

  // [Risk S1] WITHOUT acknowledgement, a blanket allow on a sensitive category
  // is escalated to approval — and default-denies when no approver exists.
  it("escalates a sensitive allow to deny under the unrestricted default (no acknowledgement, no approver)", async () => {
    const gate = gateWithRules(UNRESTRICTED); // command_execution: "allow"
    const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);
    expect(selectedId(res)).toBe("reject_once_id");
  });
  it("auto-allows a sensitive call only when the unrestricted risk is acknowledged", async () => {
    const gate = gateWithRules(UNRESTRICTED);
    const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate, {
      allowUnrestricted: true,
    });
    expect(selectedId(res)).toBe("allow_once_id");
  });
  it("never escalates an exempt (read-only) kind regardless of acknowledgement", async () => {
    const gate = gateWithRules(UNRESTRICTED);
    const res = await resolvePermission(toolCall("read"), ALL_OPTIONS, gate);
    expect(selectedId(res)).toBe("allow_once_id");
  });

  it("exempt kinds (read) always allow via allow_once", async () => {
    // Even with a block-everything policy, a read-only kind is exempt → allow.
    const gate = gateWithRules({
      git_write: "block",
      file_write_delete: "block",
      command_execution: "block",
      network_api: "block",
      task_agent_mutation: "block",
    });
    const res = await resolvePermission(toolCall("read"), ALL_OPTIONS, gate);
    expect(selectedId(res)).toBe("allow_once_id");
  });

  // [KTD3a] missing / other / unknown kind → denied even under unrestricted.
  it("denies a missing kind even under the unrestricted default", async () => {
    const gate = gateWithRules(UNRESTRICTED);
    const res = await resolvePermission(toolCall(undefined), ALL_OPTIONS, gate);
    expect(selectedId(res)).toBe("reject_once_id");
  });
  it("denies an `other` kind even under the unrestricted default", async () => {
    const gate = gateWithRules(UNRESTRICTED);
    const res = await resolvePermission(toolCall("other"), ALL_OPTIONS, gate);
    expect(selectedId(res)).toBe("reject_once_id");
  });

  // No gate / no policy → default-deny.
  it("default-denies when no gate is supplied", async () => {
    const res = await resolvePermission(toolCall("read"), ALL_OPTIONS, undefined);
    expect(selectedId(res)).toBe("reject_once_id");
  });
  it("default-denies when permissionPolicy is absent", async () => {
    const res = await resolvePermission(toolCall("read"), ALL_OPTIONS, {} as PermissionGate);
    expect(selectedId(res)).toBe("reject_once_id");
  });

  // Options missing the expected *_once kind → safe fallback, never *_always, no throw.
  it("falls back to cancelled (never allow_always) when an allow category offers no allow_once", async () => {
    const gate = gateWithRules({ ...UNRESTRICTED, command_execution: "allow" });
    const noAllowOnce: PermissionOption[] = [
      { optionId: "allow_always_id", name: "Allow always", kind: "allow_always" },
      { optionId: "reject_always_id", name: "Reject always", kind: "reject_always" },
    ];
    const res = await resolvePermission(toolCall("execute"), noAllowOnce, gate, {
      allowUnrestricted: true,
    });
    // No reject_once either → cancelled, and definitely not allow_always.
    expect(res.outcome.outcome).toBe("cancelled");
    expect(selectedId(res)).toBeUndefined();
  });

  describe("require-approval HITL", () => {
    it("creates an approval request, blocks until decision, granted → allow_once", async () => {
      let resolvePause: (() => void) | undefined;
      const order: string[] = [];
      const gate: PermissionGate = gateWithRules(
        { ...UNRESTRICTED, command_execution: "require-approval" },
        {
          createApprovalRequest: vi.fn(async () => {
            order.push("create");
            return { id: "appr-1" };
          }),
          findApprovalByDedupeKey: vi
            .fn()
            // first lookup (reuse check): nothing prior
            .mockResolvedValueOnce(null)
            // second lookup (after pause): approved
            .mockResolvedValueOnce({ id: "appr-1", status: "approved" }),
          pauseForApproval: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                order.push("pause");
                resolvePause = () => {
                  order.push("resume");
                  resolve();
                };
              }),
          ),
          markApprovalCompleted: vi.fn(async () => {
            order.push("complete");
          }),
        },
      );

      const promise = resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);

      // It must be blocked on pauseForApproval — give the microtask queue a tick.
      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(["create", "pause"]);

      resolvePause!();
      const res = await promise;
      expect(selectedId(res)).toBe("allow_once_id");
      expect(gate.createApprovalRequest).toHaveBeenCalledTimes(1);
      expect(gate.markApprovalCompleted).toHaveBeenCalledWith("appr-1");
      expect(order).toEqual(["create", "pause", "resume", "complete"]);
    });

    it("rejected decision → reject_once", async () => {
      const gate: PermissionGate = gateWithRules(
        { ...UNRESTRICTED, command_execution: "require-approval" },
        {
          createApprovalRequest: vi.fn(async () => ({ id: "appr-2" })),
          findApprovalByDedupeKey: vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "appr-2", status: "denied" }),
          pauseForApproval: vi.fn(async () => undefined),
          markApprovalCompleted: vi.fn(async () => undefined),
        },
      );
      const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);
      expect(selectedId(res)).toBe("reject_once_id");
    });

    it("timeout/error during pause → reject_once (no throw)", async () => {
      const gate: PermissionGate = gateWithRules(
        { ...UNRESTRICTED, command_execution: "require-approval" },
        {
          createApprovalRequest: vi.fn(async () => ({ id: "appr-3" })),
          findApprovalByDedupeKey: vi.fn().mockResolvedValueOnce(null),
          pauseForApproval: vi.fn(async () => {
            throw new Error("timed out");
          }),
        },
      );
      const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);
      expect(selectedId(res)).toBe("reject_once_id");
    });

    it("reuses a prior approved decision via the dedupe key (no new request)", async () => {
      const createApprovalRequest = vi.fn(async () => ({ id: "appr-x" }));
      const gate: PermissionGate = gateWithRules(
        { ...UNRESTRICTED, command_execution: "require-approval" },
        {
          createApprovalRequest,
          findApprovalByDedupeKey: vi.fn(async () => ({ id: "prior", status: "approved" as const })),
        },
      );
      const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);
      expect(selectedId(res)).toBe("allow_once_id");
      expect(createApprovalRequest).not.toHaveBeenCalled();
    });

    it("require-approval with NO closures → default-deny, no throw", async () => {
      const gate = gateWithRules({ ...UNRESTRICTED, command_execution: "require-approval" });
      const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);
      expect(selectedId(res)).toBe("reject_once_id");
    });

    it("require-approval with createApprovalRequest but no pauseForApproval → default-deny (no orphaned request)", async () => {
      const createApprovalRequest = vi.fn(async () => ({ id: "a" }));
      const gate: PermissionGate = gateWithRules(
        { ...UNRESTRICTED, command_execution: "require-approval" },
        { createApprovalRequest },
      );
      const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);
      expect(selectedId(res)).toBe("reject_once_id");
      // Without a way to pause for a decision, no request is committed to the
      // store — otherwise it would sit perpetually `pending`.
      expect(createApprovalRequest).not.toHaveBeenCalled();
    });
  });

  it("treats a category with no explicit rule as require-approval (not allow)", async () => {
    // command_execution missing from rules entirely → require-approval → with no
    // closures that default-denies (never silent allow).
    const gate = gateWithRules({ git_write: "allow" });
    const res = await resolvePermission(toolCall("execute"), ALL_OPTIONS, gate);
    expect(selectedId(res)).toBe("reject_once_id");
  });
});
