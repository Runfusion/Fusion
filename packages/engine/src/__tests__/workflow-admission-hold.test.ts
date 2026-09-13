import { describe, expect, it, vi } from "vitest";
import { holdWorkflowAdmission, workflowAdmissionHoldReason } from "../executor/workflow-admission-hold.js";

describe("workflow admission hold settlement", () => {
  it.each([
    ["principal-hold", "workflow-principal-role-pool-exhausted:reviewer"],
    ["principal-hold", "workflow-principal-agent-capacity"],
    ["principal-hold", "workflow-principal-named-principal-unavailable"],
    ["principal-hold", "workflow-principal-routing-unavailable"],
    ["dependency-configuration-block", "dependency-configuration-blocked"],
  ])("holds all owned leases for %s / %s", async (marker, reason) => {
    const transitionWorkflowWorkItem = vi.fn().mockResolvedValue(undefined);
    const actual = workflowAdmissionHoldReason({ disposition: "suspended", context: { [`node:step-done:${marker}`]: reason } });
    expect(actual).toBe(reason);
    await holdWorkflowAdmission({ transitionWorkflowWorkItem }, actual!, "continuation", new Set(["continuation", "fence", "already-held"]), new Set(["already-held"]));
    expect(transitionWorkflowWorkItem.mock.calls).toEqual(["continuation", "fence"].map(id => [id, "held", {
      leaseOwner: null, leaseExpiresAt: null, lastError: reason, blockedReason: reason,
    }]));
  });

  it("uses a stable reason, not diagnostic prose, for configuration holds", () => {
    expect(workflowAdmissionHoldReason({ disposition: "suspended", context: { "node:review:dependency-configuration-block": "command stderr" } })).toBe("dependency-configuration-blocked");
  });

  it("ignores absent, unrelated, malformed and stale markers", () => {
    for (const context of [undefined, {}, { output: "workflow-principal-unavailable" }, { "node:review:output": "workflow-principal-unavailable" }, { "node:review:principal-hold": false }, { "node:review:principal-hold": "unrelated" }]) {
      expect(workflowAdmissionHoldReason({ disposition: "suspended", context })).toBeUndefined();
    }
    for (const disposition of ["completed", "failed", "fell-back"] as const) {
      expect(workflowAdmissionHoldReason({ disposition, context: { "node:review:principal-hold": "workflow-principal-unavailable" } })).toBeUndefined();
    }
  });

  /*
  FNXC:WorkflowAdmission 2026-09-13-08:31:
  FN-375 deleted the overlap revalidation gate, drained its wait rows and constrained the phase
  column so it cannot return. A residual episode replayed from an older engine must therefore be
  inert rather than a durable hold: honouring it would let a retired pre-node review gate suspend
  graph execution, which the legacy-tombstone ratchet forbids.
  */
  it("does not hold on a retired overlap revalidation marker", () => {
    for (const value of ["overlap-plan-revalidation-revise", "overlap-plan-revalidation-unavailable", "overlap-plan-revalidation-superseded"]) {
      expect(workflowAdmissionHoldReason({ disposition: "suspended", context: { "node:review:principal-hold": value } })).toBeUndefined();
    }
  });

  it("does not swallow failed lease settlement or claim a successful hold", async () => {
    const transitionWorkflowWorkItem = vi.fn().mockRejectedValue(new Error("store unavailable"));
    await expect(holdWorkflowAdmission({ transitionWorkflowWorkItem }, "workflow-principal-unavailable", "continuation", new Set(), new Set())).rejects.toThrow("store unavailable");
  });
});
