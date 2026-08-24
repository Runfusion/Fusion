import { describe, expect, it } from "vitest";
import {
  classifyMergeSweepAdmission,
  DEFAULT_MERGE_SWEEP_QUIESCENCE_MS,
  type MergeSweepAdmissionInput,
} from "../merge/merge-sweep-admission.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { classifyWorkflowNodeMergeRegion, isMergeRegionNode } from "../workflows/workflow-merge-region.js";

/** A card the graph is holding mid-execution: nothing here may merge. */
function input(overrides: Partial<MergeSweepAdmissionInput> = {}): MergeSweepAdmissionInput {
  return {
    irTrust: "cards-own",
    continuationPositions: ["outside-merge-region"],
    continuationsReadable: true,
    mergeConfirmed: false,
    hasLiveSession: false,
    interruptedMergeAttempt: false,
    quiescentMs: 10 * 60_000,
    gatesSatisfied: true,
    ...overrides,
  };
}

describe("classifyWorkflowNodeMergeRegion", () => {
  it("separates the built-in coding workflow's merge region from its review lane", () => {
    for (const nodeId of ["merge-gate", "merge-attempt", "merge-retry", "merge-manual-hold", "recovery-router"]) {
      expect(classifyWorkflowNodeMergeRegion(BUILTIN_CODING_WORKFLOW_IR, nodeId)).toBe("merge-region");
    }
    for (const nodeId of ["execute", "review", "planning"]) {
      expect(classifyWorkflowNodeMergeRegion(BUILTIN_CODING_WORKFLOW_IR, nodeId)).toBe("outside-merge-region");
    }
  });

  /* Multi-repo: a shared-branch member's integration/promotion nodes ARE its merge lane. Excluding
     them would freeze branch-group auto-merge recovery entirely. */
  it("treats branch-group integration and promotion as merge region", () => {
    expect(classifyWorkflowNodeMergeRegion(BUILTIN_CODING_WORKFLOW_IR, "branch-group-member-integration"))
      .toBe("merge-region");
    expect(classifyWorkflowNodeMergeRegion(BUILTIN_CODING_WORKFLOW_IR, "branch-group-promotion"))
      .toBe("merge-region");
  });

  it("reports an unknown node id rather than guessing", () => {
    expect(classifyWorkflowNodeMergeRegion(BUILTIN_CODING_WORKFLOW_IR, "node-from-a-newer-ir")).toBe("unknown");
  });

  /* Linear/seam workflows express merge as a prompt node; the kind set alone would miss them. */
  it("counts a legacy merge seam prompt node as merge region", () => {
    expect(isMergeRegionNode({ kind: "prompt", config: { seam: "merge" } })).toBe(true);
    expect(isMergeRegionNode({ kind: "prompt", config: { seam: "review" } })).toBe(false);
  });
});

describe("classifyMergeSweepAdmission", () => {
  /*
  FN-9193 SYMPTOM: the sweep merged a card whose Code Review was mid-re-run. Code Review then
  requested revision and reset the steps, and the already-approved merge landed anyway — leaving
  `mergeConfirmed` + incomplete steps, which nothing could finalize.
  */
  it("refuses a card the graph is holding outside its merge region", () => {
    expect(classifyMergeSweepAdmission(input({ continuationPositions: ["outside-merge-region"] })))
      .toEqual({ admit: false, reason: "not-at-merge-region-node" });
  });

  it("refuses while any session is live, whatever the graph position", () => {
    expect(classifyMergeSweepAdmission(input({ hasLiveSession: true, continuationPositions: ["merge-region"] })))
      .toEqual({ admit: false, reason: "live-session" });
    expect(classifyMergeSweepAdmission(input({ hasLiveSession: true, mergeConfirmed: true })))
      .toEqual({ admit: false, reason: "live-session" });
  });

  it("admits a card parked at a merge-region node", () => {
    expect(classifyMergeSweepAdmission(input({ continuationPositions: ["merge-region"] })))
      .toEqual({ admit: true, reason: "at-merge-region-node" });
  });

  /* FN-9193's aftermath: the branch landed, so only finalization is left. */
  it("admits a confirmed merge for finalization even with the graph elsewhere", () => {
    expect(classifyMergeSweepAdmission(input({ mergeConfirmed: true, continuationPositions: ["outside-merge-region"] })))
      .toEqual({ admit: true, reason: "merge-confirmed-finalization" });
  });

  it("admits an interrupted merge attempt only when no continuation contradicts it", () => {
    expect(classifyMergeSweepAdmission(input({ continuationPositions: [], interruptedMergeAttempt: true })))
      .toEqual({ admit: true, reason: "interrupted-merge-attempt" });
    // Stale merge residue must NOT override where the card is now — this is FN-9193's second pass.
    expect(classifyMergeSweepAdmission(input({
      continuationPositions: ["outside-merge-region"],
      interruptedMergeAttempt: true,
    }))).toEqual({ admit: false, reason: "not-at-merge-region-node" });
  });

  it("fails open for a drifted continuation node", () => {
    expect(classifyMergeSweepAdmission(input({ continuationPositions: ["unknown"] })))
      .toEqual({ admit: true, reason: "drifted-continuation-node" });
  });

  /*
  A card with no stored selection runs on the PROJECT DEFAULT workflow, so that graph is its real
  graph and its positions must still be honoured. Reviving a "no selection -> admit anything"
  fail-open here would reopen the whole hole this classifier closes.
  */
  it("honours graph position for a card running on the project default workflow", () => {
    expect(classifyMergeSweepAdmission(input({
      irTrust: "effective-default",
      continuationPositions: ["outside-merge-region"],
    }))).toEqual({ admit: false, reason: "not-at-merge-region-node" });
    expect(classifyMergeSweepAdmission(input({
      irTrust: "effective-default",
      continuationPositions: ["merge-region"],
    }))).toEqual({ admit: true, reason: "at-merge-region-node" });
  });

  describe("quiescent-stall fallback", () => {
    const stalled = { continuationPositions: [] as const };

    it("rescues a quiescent card whose gates are all satisfied", () => {
      expect(classifyMergeSweepAdmission(input({ ...stalled, quiescentMs: DEFAULT_MERGE_SWEEP_QUIESCENCE_MS })))
        .toEqual({ admit: true, reason: "quiescent-stall-recovery" });
    });

    it("refuses inside the quiescence floor — the FN-9193 race window", () => {
      expect(classifyMergeSweepAdmission(input({ ...stalled, quiescentMs: 17_000 })))
        .toEqual({ admit: false, reason: "too-recent" });
      expect(classifyMergeSweepAdmission(input({ ...stalled, quiescentMs: DEFAULT_MERGE_SWEEP_QUIESCENCE_MS - 1 })))
        .toEqual({ admit: false, reason: "too-recent" });
    });

    it("refuses when a pre-merge gate is unrun, pending, or failed — the FN-9191 race window", () => {
      expect(classifyMergeSweepAdmission(input({ ...stalled, gatesSatisfied: false })))
        .toEqual({ admit: false, reason: "gates-unsatisfied" });
    });

    it("treats an unparseable quiescence as maximally quiescent, not as zero", () => {
      expect(classifyMergeSweepAdmission(input({ ...stalled, quiescentMs: Number.POSITIVE_INFINITY })))
        .toEqual({ admit: true, reason: "quiescent-stall-recovery" });
    });
  });

  /*
  FNXC:MergeAuthority 2026-08-23-20:05 — review findings #3-#6, pinned as behaviour.
  */
  describe("review hardening", () => {
    it("refuses to initiate when the continuation read failed (#4)", () => {
      // Unreadable must not read as "nothing scheduled": that was the precondition for both
      // remaining admit paths, so a transient DB error could admit a mid-execution card.
      expect(classifyMergeSweepAdmission(input({
        continuationsReadable: false,
        continuationPositions: [],
        interruptedMergeAttempt: true,
      }))).toEqual({ admit: false, reason: "continuations-unreadable" });
    });

    it("still finalizes an already-landed merge when continuations are unreadable (#4)", () => {
      // The branch is on the target already; refusing here re-creates FN-9193's unfinalizable card.
      expect(classifyMergeSweepAdmission(input({ continuationsReadable: false, mergeConfirmed: true })))
        .toEqual({ admit: true, reason: "merge-confirmed-finalization" });
    });

    it("fences EVERY initiation on satisfied gates, not just the quiescent path (#6)", () => {
      // Without this the merge door's deferral re-enqueued the same card every sweep forever.
      for (const overrides of [
        { continuationPositions: ["merge-region"] as const },
        { continuationPositions: ["unknown"] as const },
        { continuationPositions: [] as const, interruptedMergeAttempt: true },
        { irTrust: "effective-default" as const, continuationPositions: [] as const },
      ]) {
        expect(classifyMergeSweepAdmission(input({ ...overrides, gatesSatisfied: false })))
          .toEqual({ admit: false, reason: "gates-unsatisfied" });
      }
      // A landed merge is finalization, not initiation, so it is exempt.
      expect(classifyMergeSweepAdmission(input({ mergeConfirmed: true, gatesSatisfied: false })))
        .toEqual({ admit: true, reason: "merge-confirmed-finalization" });
    });

    it("does not trust an unresolved selection's node ids (#5)", () => {
      // A named-but-unresolved workflow returns a DIFFERENT graph, so position is unusable — only
      // the fenced quiescent path remains, and it needs quiescence, not a node classification.
      expect(classifyMergeSweepAdmission(input({
        irTrust: "unresolved-selection",
        continuationPositions: ["unknown"],
        quiescentMs: 10 * 60_000,
      }))).toEqual({ admit: true, reason: "unresolved-workflow-ir" });
      expect(classifyMergeSweepAdmission(input({
        irTrust: "unresolved-selection",
        continuationPositions: ["unknown"],
        quiescentMs: 5_000,
      }))).toEqual({ admit: false, reason: "too-recent" });
    });
  });
});
