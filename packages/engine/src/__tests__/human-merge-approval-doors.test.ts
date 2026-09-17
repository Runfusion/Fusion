/*
FNXC:HumanMergeApproval 2026-09-17-18:09:
FN-514 — every DELIVERY DOOR must refuse a locked card, and none of them may accept a `create-pr`
authorization as proof of a merge. These assert the OBSERVABLE door decision (the blocker a door
reports, and whether the barrier lets a delivery node run), not the presence of a call.

Surface enumeration covered here:
  • `getTaskMergeBlocker` (the shared predicate behind moves, merge-queue admission, artifacts ops,
    in-review stall and self-healing) with and without live evidence.
  • `getTaskHardMergeBlocker` / `getMergeConfirmedFinalizationBlocker`: already-landed work must NOT
    be parked by a lock appearing in history.
  • The graph delivery barrier across every delivery node kind, plus the nodes it must NOT block.
  • create-pr in flight, succeeded, and failed.
  • Project auto-merge Off and pauses remain independently enforced.
*/
import { describe, expect, it, vi } from "vitest";
import {
  getMergeConfirmedFinalizationBlocker,
  getTaskHardMergeBlocker,
  getTaskMergeBlocker,
  HUMAN_MERGE_APPROVAL_BLOCKER,
  HUMAN_MERGE_REJECTION_BLOCKER,
  isHumanMergeApprovalBlocker,
  type HumanMergeApprovalState,
  type Task,
} from "@fusion/core";

import {
  evaluateHumanMergeDeliveryBarrier,
  HUMAN_MERGE_DELIVERY_NODE_KINDS,
  isHumanMergeDeliveryNode,
} from "../workflows/human-merge-approval-boundary.js";

const CANDIDATE = {
  lockGeneration: 1,
  workflowSignature: "builtin:coding@7",
  reviewEpisodeId: "2026-09-17T10:00:00.000Z",
  contentSignature: "singular:fp:abc",
  targetSignature: "merge:.@origin:fusion/FN-514->main",
};

function task(state: HumanMergeApprovalState | undefined, over: Partial<Task> = {}): Task {
  return {
    id: "FN-514",
    column: "in-review",
    steps: [],
    workflowStepResults: [],
    humanMergeApproval: state,
    ...over,
  } as unknown as Task;
}

const ARMED: HumanMergeApprovalState = { enabled: true, generation: 1 };
const MERGE_OK: HumanMergeApprovalState = {
  enabled: true,
  generation: 1,
  decision: { requestId: "r", action: "merge", deliveryAction: "merge", decidedBy: "op", decidedAt: "t", candidate: CANDIDATE },
};
const CREATE_PR: HumanMergeApprovalState = {
  enabled: true,
  generation: 1,
  decision: { requestId: "r", action: "create-pr", deliveryAction: "create-pr", decidedBy: "op", decidedAt: "t", candidate: { ...CANDIDATE, targetSignature: "create-pr:.@origin:fusion/FN-514->main" } },
};

describe("FN-514 — the shared merge-door predicate", () => {
  it("refuses a locked card with no decision, and classifies it as a human wait, not a failure", () => {
    const blocker = getTaskMergeBlocker(task(ARMED));
    expect(blocker).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
    expect(isHumanMergeApprovalBlocker(blocker)).toBe(true);
  });

  it("opens only for a merge authorization, never for a create-pr one", () => {
    expect(getTaskMergeBlocker(task(MERGE_OK))).toBeUndefined();
    expect(getTaskMergeBlocker(task(CREATE_PR))).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
  });

  it("still refuses when the live content is not the approved content", () => {
    expect(getTaskMergeBlocker(task(MERGE_OK), {
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "different" } },
    })).toBe(HUMAN_MERGE_APPROVAL_BLOCKER);
    // The matching content opens it.
    expect(getTaskMergeBlocker(task(MERGE_OK), {
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "abc" } },
    })).toBeUndefined();
  });

  it("reports a pending rejection ahead of any approval consideration", () => {
    const rejected: HumanMergeApprovalState = {
      ...MERGE_OK,
      rejection: { requestId: "j", instruction: "refais la nav", rejectedBy: "op", rejectedAt: "t", candidate: CANDIDATE, remediationGeneration: 1, state: "pending" },
    };
    expect(getTaskMergeBlocker(task(rejected))).toBe(HUMAN_MERGE_REJECTION_BLOCKER);
  });

  it("evaluates the lock only AFTER the automatic gates, so the operator is asked about finished work", () => {
    const unfinished = task(ARMED, { steps: [{ name: "s", status: "pending" }] as never });
    expect(getTaskMergeBlocker(unfinished)).toBe("task has incomplete steps");
    const paused = task(ARMED, { paused: true } as Partial<Task>);
    expect(getTaskMergeBlocker(paused)).toBe("task is paused");
  });

  it("leaves a card with no lock exactly as it was", () => {
    expect(getTaskMergeBlocker(task(undefined))).toBeUndefined();
    expect(getTaskMergeBlocker(task({ enabled: false, generation: 2 }))).toBeUndefined();
  });

  it("never parks ALREADY-LANDED work because a lock appears in its history", () => {
    /*
    A branch already on the target cannot be un-landed by a button. Reporting the lock at these
    recovery doors would only park proven delivery as failed.
    */
    expect(getTaskHardMergeBlocker(task(ARMED))).toBeUndefined();
    const landed = task(ARMED, {
      mergeDetails: { mergeConfirmed: true, commitSha: "deadbeef" } as never,
      steps: [{ name: "s", status: "pending" }] as never,
    });
    expect(getMergeConfirmedFinalizationBlocker(landed)).toBeUndefined();
  });
});

describe("FN-514 — the graph delivery barrier", () => {
  const deps = (over: Partial<Parameters<typeof evaluateHumanMergeDeliveryBarrier>[2]> = {}) => ({
    store: {
      getTask: vi.fn(async () => undefined),
      updateHumanMergeDecisionReceipt: vi.fn(async () => ({ applied: true })),
      logEntry: vi.fn(async () => undefined),
    } as never,
    ...over,
  });

  it("classifies exactly the four delivery-effecting node kinds", () => {
    expect([...HUMAN_MERGE_DELIVERY_NODE_KINDS].sort()).toEqual([
      "branch-group-member-integration", "branch-group-promotion", "merge-attempt", "pr-merge",
    ]);
    for (const kind of ["execute", "prompt", "optional-group", "pr-create", "pr-respond", "merge-gate", "manual-merge-hold", "code"]) {
      expect(isHumanMergeDeliveryNode({ kind } as never), kind).toBe(false);
    }
  });

  it("lets every non-delivery node run untouched on a locked card", async () => {
    for (const kind of ["execute", "prompt", "optional-group", "pr-create", "merge-gate"]) {
      const outcome = await evaluateHumanMergeDeliveryBarrier({ id: kind, kind } as never, task(ARMED), deps());
      expect(outcome, kind).toEqual({ kind: "proceed" });
    }
  });

  it("holds every delivery node on a locked card with no decision", async () => {
    for (const kind of HUMAN_MERGE_DELIVERY_NODE_KINDS) {
      const outcome = await evaluateHumanMergeDeliveryBarrier({ id: kind, kind } as never, task(ARMED), deps());
      expect(outcome.kind, kind).toBe("hold");
    }
  });

  it("proceeds for a merge authorization and holds for a create-pr one", async () => {
    const merge = await evaluateHumanMergeDeliveryBarrier({ id: "m", kind: "merge-attempt" } as never, task(MERGE_OK), deps());
    expect(merge).toEqual({ kind: "proceed" });

    const createPr = await evaluateHumanMergeDeliveryBarrier({ id: "m", kind: "merge-attempt" } as never, task(CREATE_PR), deps({
      createPullRequest: vi.fn(async () => ({ state: "created" as const, prNumber: 7, prUrl: "https://example.test/pr/7" })),
    }));
    expect(createPr.kind).toBe("hold");
  });

  it("dispatches the create-pr handoff exactly once, records the link, and still holds", async () => {
    const createPullRequest = vi.fn(async () => ({ state: "created" as const, prNumber: 7, prUrl: "https://example.test/pr/7" }));
    const receipts: unknown[] = [];
    const store = {
      getTask: vi.fn(async () => undefined),
      updateHumanMergeDecisionReceipt: vi.fn(async (_id: string, input: { receipt: unknown }) => {
        receipts.push(input.receipt);
        return { applied: true };
      }),
      logEntry: vi.fn(async () => undefined),
    } as never;

    const outcome = await evaluateHumanMergeDeliveryBarrier(
      { id: "m", kind: "merge-attempt" } as never,
      task(CREATE_PR),
      { store, createPullRequest },
    );

    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(receipts).toEqual([
      expect.objectContaining({ state: "dispatching" }),
      expect.objectContaining({ state: "succeeded", prNumber: 7, prUrl: "https://example.test/pr/7" }),
    ]);
    // A created PR is a handoff, not a merge authorization.
    expect(outcome.kind).toBe("hold");
  });

  it("does not re-dispatch a settled create-pr intent, and never switches to a merge on failure", async () => {
    const settled = structuredClone(CREATE_PR);
    settled.decision!.receipt = { state: "succeeded", at: "t", prNumber: 7, prUrl: "u" };
    const createPullRequest = vi.fn(async () => ({ state: "created" as const, prNumber: 9, prUrl: "other" }));
    const outcome = await evaluateHumanMergeDeliveryBarrier(
      { id: "m", kind: "merge-attempt" } as never, task(settled), deps({ createPullRequest }),
    );
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("hold");

    // A failed handoff stays on the SAME action.
    const failing = vi.fn(async () => ({ state: "failed" as const, error: "no auth" }));
    const failed = await evaluateHumanMergeDeliveryBarrier(
      { id: "m", kind: "merge-attempt" } as never, task(CREATE_PR), deps({ createPullRequest: failing }),
    );
    expect(failed.kind).toBe("hold");
  });

  it("records an indeterminate provider outcome as failed-with-reason rather than a clean failure", async () => {
    const receipts: { state: string; error?: string }[] = [];
    const store = {
      getTask: vi.fn(async () => undefined),
      updateHumanMergeDecisionReceipt: vi.fn(async (_id: string, input: { receipt: { state: string; error?: string } }) => {
        receipts.push(input.receipt);
        return { applied: true };
      }),
      logEntry: vi.fn(async () => undefined),
    } as never;
    await evaluateHumanMergeDeliveryBarrier({ id: "m", kind: "merge-attempt" } as never, task(CREATE_PR), {
      store,
      createPullRequest: vi.fn(async () => { throw new Error("socket hang up"); }),
    });
    expect(receipts.at(-1)).toMatchObject({ state: "failed", error: expect.stringContaining("socket hang up") });
  });

  it("re-reads the live task so a decision landed mid-run is observed", async () => {
    const store = {
      getTask: vi.fn(async () => task(MERGE_OK)),
      updateHumanMergeDecisionReceipt: vi.fn(async () => ({ applied: true })),
      logEntry: vi.fn(async () => undefined),
    } as never;
    // The snapshot the graph started with is stale (no decision); the live row authorizes.
    const outcome = await evaluateHumanMergeDeliveryBarrier({ id: "m", kind: "merge-attempt" } as never, task(ARMED), { store });
    expect(store.getTask).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "proceed" });
  });

  it("holds on a pending rejection even when a merge accord exists", async () => {
    const rejected = structuredClone(MERGE_OK);
    rejected.rejection = { requestId: "j", instruction: "refais", rejectedBy: "op", rejectedAt: "t", candidate: CANDIDATE, remediationGeneration: 1, state: "pending" };
    const outcome = await evaluateHumanMergeDeliveryBarrier({ id: "m", kind: "merge-attempt" } as never, task(rejected), deps());
    expect(outcome.kind).toBe("hold");
    expect((outcome as { reason: string }).reason).toContain("corrections");
  });

  it("refuses to deliver when live evidence contradicts the approval", async () => {
    const outcome = await evaluateHumanMergeDeliveryBarrier({ id: "m", kind: "merge-attempt" } as never, task(MERGE_OK), deps({
      resolveEvidence: async () => ({ mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "git failed" } } }),
    }));
    expect(outcome.kind).toBe("hold");
  });
});
