/*
FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
Symptom Verification shapes (a)-(m), asserted at the seam that decides them. Half 2's claim is not "a card
with no rows gets a pass" — it is "a card whose DELIVERY SURFACE can no longer answer is exempt, and every
other card is not", so the negative rows are the content of this file, not an afterthought: a divergent ref,
an unreadable probe, a missing landing leg, a producer that can still run, or any written row must all keep
the blocker sentence byte-for-byte.

The two motivating boards are the shape-(a)/(b) pair (VLLM-081: branch gone, no post-merge work item ever)
and the shape-(c)/(d) pair (RUFU-326 / SANE-126: a continuation row EXISTS and is non-dispatchable). A
fixture set whose only negative case is the zero-row card would ship the shape-(a) predicate and leave
RUFU-326 wedged, which the spec names as the failure mode to avoid.
*/
import { describe, expect, it } from "vitest";
import {
  getPostMergeEvidenceGateStatuses,
  getRequiredPostMergeEvidenceBlocker,
  getRequiredPostMergeEvidenceDecision,
} from "../merge/confirmed-merge-reconciliation.js";
import {
  isPostMergeProducerUnreachable,
  type PostMergeProducerSurfaceObservation,
} from "../merge/post-merge-producer-surface.js";
import {
  POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY,
  POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS,
  decidePostMergeEvidenceRefusal,
  postMergeEvidenceRefusalSignature,
  readPostMergeEvidenceRefusalEpisode,
} from "../merge/post-merge-evidence-refusal-episode.js";
import { derivePostMergeEvidenceContract, type PostMergeEvidenceContract } from "../merge/post-merge-evidence-contract.js";
import * as fullBarrel from "../index.js";
import * as gateBarrel from "../index.gate.js";
import type { Task, WorkflowIr } from "../types.js";

const GATE_ID = "post-merge-verification";

function irWithPostMergeGate(evidence?: { kind: string }): WorkflowIr {
  return {
    version: "v2",
    id: "builtin:coding",
    name: "Coding",
    nodes: [
      {
        id: GATE_ID,
        kind: "optional-group",
        column: "in-review",
        config: {
          phase: "post-merge",
          defaultOn: true,
          ...(evidence ? { evidence } : {}),
          template: { nodes: [{ id: "post-merge-check", kind: "prompt", config: { gateMode: "gate" } }] },
        },
      },
    ],
    edges: [],
    columns: [{ id: "in-review", label: "In review", traits: [] }],
  } as unknown as WorkflowIr;
}

const ir = irWithPostMergeGate();

function taskWithRows(
  rows: Array<Record<string, unknown>> | [],
  extra: Partial<Task> = {},
): Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults"> {
  return {
    id: "RUFU-450",
    enabledWorkflowSteps: [GATE_ID],
    workflowStepResults: rows as never,
    ...extra,
  } as Pick<Task, "id" | "enabledWorkflowSteps" | "workflowStepResults">;
}

function storeFor(workflowIr: WorkflowIr) {
  return {
    getTaskWorkflowSelection: () => ({ workflowId: "builtin:coding", stepIds: [] }),
    getWorkflowDefinition: async () => ({ ir: workflowIr }),
  } as never;
}

/** The landed-and-clean observation every exemption row shares; each row overrides only its own leg. */
function landed(overrides: Partial<PostMergeProducerSurfaceObservation> = {}): PostMergeProducerSurfaceObservation {
  return { surface: "ref-absent", mergeConfirmed: true, producerCanRun: false, ...overrides };
}

/** The no-reporter contract, used only by the row that pins the ladder's precedence over the new arm. */
const noReporter: PostMergeEvidenceContract = derivePostMergeEvidenceContract({
  declared: { provider: "none" },
  repo: { factsReadable: true, remoteUrl: "https://example.invalid/repo.git", githubWorkflowFileCount: 0 },
});

describe("isPostMergeProducerUnreachable — the pure rule over the injected observation", () => {
  it("exempts only a durable landing with a conclusive git verdict and nothing left to run", () => {
    expect(isPostMergeProducerUnreachable(landed({ surface: "ref-absent" }))).toBe(true);
    expect(isPostMergeProducerUnreachable(landed({ surface: "ref-merged" }))).toBe(true);
  });

  it("keeps demanding evidence for every leg that is not conclusive", () => {
    // The target still owes this card's commits.
    expect(isPostMergeProducerUnreachable(landed({ surface: "ref-divergent" }))).toBe(false);
    // We could not ask: probe failed, timed out, root gone, target unresolvable.
    expect(isPostMergeProducerUnreachable(landed({ surface: "unknown" }))).toBe(false);
    // No observation at all is never evidence that a gate may be relaxed.
    expect(isPostMergeProducerUnreachable(undefined)).toBe(false);
  });

  it("never exempts on an absent landing leg or an absent dispatchability leg", () => {
    // Row (h): this is the ONLY difference from row (a), and it is what separates the two outcomes.
    expect(isPostMergeProducerUnreachable({ surface: "ref-absent", mergeConfirmed: false, producerCanRun: false })).toBe(false);
    // `producerCanRun` absent means the engine never measured it — the demand stands.
    expect(isPostMergeProducerUnreachable({ surface: "ref-absent", mergeConfirmed: true })).toBe(false);
    // Row (m): a producer that can still run is never pre-empted.
    expect(isPostMergeProducerUnreachable(landed({ producerCanRun: true }))).toBe(false);
    expect(isPostMergeProducerUnreachable(landed({ surface: "ref-merged", producerCanRun: true }))).toBe(false);
  });
});

describe("post-merge evidence requirement under the producer-surface observation", () => {
  /*
  FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
  Rows (a)-(d): the four measured landed shapes. (b) is the shape the prohibited pointer test could never
  fire on — `worktree` cleared, `branch` still a stale string naming a ref git no longer has. (c) is
  RUFU-326's 0/0: the pointer names a ref fully contained in its merge target. (d) is the row that decides
  whether Half 2 is real: the card CARRIES a continuation row, and the exemption still holds, because
  dispatchability is measured from git plus a liveness read and not from whether a row exists.
  */
  const landedShapes: Array<[string, PostMergeProducerSurfaceObservation]> = [
    ["(a) ref-absent with both pointers cleared", landed({ surface: "ref-absent" })],
    ["(b) ref-absent behind a stale non-null branch pointer", landed({ surface: "ref-absent" })],
    ["(c) ref fully merged into the target (RUFU-326's 0/0)", landed({ surface: "ref-merged" })],
    ["(d) a continuation exists but cannot advance", landed({ surface: "ref-merged" })],
  ];
  for (const [label, observation] of landedShapes) {
    it(`resolves the requirement to not-applicable for ${label}`, async () => {
      const statuses = getPostMergeEvidenceGateStatuses(taskWithRows([]), ir, undefined, observation);
      expect(statuses).toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "producer-unreachable" }]);
      // And the same fact, through the decision and the blocker every consumer reads.
      expect(await getRequiredPostMergeEvidenceDecision(storeFor(ir), taskWithRows([]), undefined, observation))
        .toEqual({ outcome: "finalizable" });
      expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir), taskWithRows([]), undefined, observation))
        .toBeUndefined();
    });
  }

  /*
  FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
  Rows (e)-(m): the demand survives. The blocker sentence is asserted byte-for-byte because four lanes and
  two dashboard breakpoints match on it.
  */
  const demanding: Array<[string, PostMergeProducerSurfaceObservation | undefined]> = [
    ["(e) a stale pointer whose ref still carries commits the target lacks", landed({ surface: "ref-divergent" })],
    ["(f) the probe failed", landed({ surface: "unknown" })],
    ["(f) no observation was produced at all", undefined],
    ["(h) the landing leg is absent", { surface: "ref-absent", mergeConfirmed: false, producerCanRun: false }],
    ["(m) the post-merge producer is still advanceable", landed({ producerCanRun: true })],
  ];
  for (const [label, observation] of demanding) {
    it(`keeps the blocker sentence byte-for-byte for ${label}`, async () => {
      expect(getPostMergeEvidenceGateStatuses(taskWithRows([]), ir, undefined, observation))
        .toEqual([{ gateId: GATE_ID, state: "missing" }]);
      expect(await getRequiredPostMergeEvidenceBlocker(storeFor(ir), taskWithRows([]), undefined, observation))
        .toBe(`required post-merge evidence gate '${GATE_ID}' has not reported`);
    });
  }

  it("never pre-empts a normal post-merge hop (row m): a landed card whose continuation is advanceable still owes the gate", async () => {
    const observation = landed({ surface: "ref-absent", producerCanRun: true });
    expect(await getRequiredPostMergeEvidenceDecision(storeFor(ir), taskWithRows([]), undefined, observation))
      .toEqual({ outcome: "resumable", gateId: GATE_ID });
  });

  /*
  FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450, rev.3 row (l)):
  The arm lives STRICTLY inside the no-row / not-run branch, so any written row short-circuits it — a card
  that already has a `pending` row is not an absence and the exemption must not touch it. rev.2's row (l)
  ("a reporter-capable board keeps the demand") was withdrawn for contradicting rows (a)-(d) on the
  motivating board, which is demonstrably reporter-capable.
  */
  it("does not touch a written pending row even when the producer surface resolves (row l)", () => {
    const rows = [{ workflowStepId: GATE_ID, status: "pending", startedAt: "2026-11-01T00:00:00.000Z" }];
    expect(getPostMergeEvidenceGateStatuses(taskWithRows(rows), ir, undefined, landed({ surface: "ref-merged" })))
      .toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });

  it("still resolves a negative verdict to not-approved while the surface says the producer is gone (row k)", () => {
    const rows = [{ workflowStepId: GATE_ID, status: "passed", verdict: "REVISE", completedAt: "2026-11-01T00:00:00.000Z" }];
    expect(getPostMergeEvidenceGateStatuses(taskWithRows(rows), ir, undefined, landed()))
      .toEqual([{ gateId: GATE_ID, state: "not-approved" }]);
  });

  it("returns no status for an approved gate no matter what the surface reports (row i)", () => {
    const rows = [{ workflowStepId: GATE_ID, status: "passed", verdict: "APPROVE", completedAt: "2026-11-01T00:00:00.000Z" }];
    expect(getPostMergeEvidenceGateStatuses(taskWithRows(rows), ir, undefined, landed())).toEqual([]);
  });

  it("keeps an operator waiver resolving as it does today (row j: a waiver returns no status)", () => {
    const rows = [{
      workflowStepId: GATE_ID,
      status: "skipped",
      completedAt: "2026-11-01T00:00:00.000Z",
      bypassedBy: "operator@example.com",
      bypassedAt: "2026-11-01T00:00:00.000Z",
      bypassReason: "released by hand",
    }];
    expect(getPostMergeEvidenceGateStatuses(taskWithRows(rows), ir, undefined, landed())).toEqual([]);
  });

  /*
  FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
  Precedence, pinned rather than asserted in prose. rev.2 placed the new arm BEFORE `delivery-shape` while
  its own text claimed the workspace arm kept precedence. A workspace card keeps its existing reason and the
  new arm never even reads the contract, so a reporter-less board keeps `no-evidence-reporter` too.
  */
  it("sits last in the absence ladder: workspace shape still reports delivery-shape with the surface present", () => {
    const workspaceTask = {
      ...taskWithRows([]),
      workspaceWorktrees: { app: { path: "/repo/.worktrees/app" } },
    } as never;
    expect(getPostMergeEvidenceGateStatuses(workspaceTask, ir, undefined, landed({ surface: "ref-merged" })))
      .toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "delivery-shape" }]);
  });

  it("sits last in the absence ladder: a reporter-less board still reports no-evidence-reporter with a divergent ref", () => {
    expect(getPostMergeEvidenceGateStatuses(taskWithRows([]), ir, noReporter, landed({ surface: "ref-divergent" })))
      .toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "no-evidence-reporter" }]);
  });

  /*
  FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
  The sharpest edge of the new cause: an `integration-only` contract names NO run, so it stays OWED on a
  board with no CI reporter (RUFU-430's own comment says so) and `no-evidence-reporter` can never release it.
  A landed card whose ref is gone therefore had exactly one exit before this card — an operator waiver —
  even on a board that was otherwise exempt. The observation is what closes that gap.
  */
  it("releases an integration-only gate on a landed card, which no reporter-based exemption can reach", () => {
    const integrationOnly = irWithPostMergeGate({ kind: "integration-only" });
    expect(getPostMergeEvidenceGateStatuses(taskWithRows([]), integrationOnly, noReporter))
      .toEqual([{ gateId: GATE_ID, state: "missing" }]);
    expect(getPostMergeEvidenceGateStatuses(taskWithRows([]), integrationOnly, noReporter, landed()))
      .toEqual([{ gateId: GATE_ID, state: "not-applicable", notApplicableReason: "producer-unreachable" }]);
  });

  it("leaves the disabled-gate case untouched: nothing is required, so nothing is exempted", async () => {
    const task = taskWithRows([]);
    const disabled = { ...task, enabledWorkflowSteps: [] } as never;
    expect(getPostMergeEvidenceGateStatuses(disabled, ir, undefined, landed())).toEqual([]);
    expect(await getRequiredPostMergeEvidenceDecision(storeFor(ir), disabled, undefined, landed()))
      .toEqual({ outcome: "finalizable" });
  });

  it("compiles and behaves unchanged for the consumer that passes neither contract nor observation", () => {
    // `complete-column-gate-evidence.ts` calls the reader with two arguments; the new arm must not fire there.
    expect(getPostMergeEvidenceGateStatuses(taskWithRows([]), ir)).toEqual([{ gateId: GATE_ID, state: "missing" }]);
  });

  it("keeps the blocking flag of a missing row unchanged while an exemption carries no status entry", () => {
    const missing = getPostMergeEvidenceGateStatuses(taskWithRows([]), ir, undefined, landed({ surface: "ref-divergent" }));
    const exempt = getPostMergeEvidenceGateStatuses(taskWithRows([]), ir, undefined, landed());
    expect(missing).toHaveLength(1);
    expect(exempt).toHaveLength(1);
    expect(exempt[0]?.state).toBe("not-applicable");
    expect(exempt[0]?.notApplicableReason).toBe("producer-unreachable");
  });

  it("preserves the duplicate-row veto over the exemption: two rows for one gate is never an absence", async () => {
    const rows = [
      { workflowStepId: GATE_ID, status: "passed", verdict: "APPROVE", completedAt: "2026-11-01T00:00:00.000Z" },
      { workflowStepId: GATE_ID, status: "passed", verdict: "APPROVE", completedAt: "2026-11-01T00:00:00.000Z" },
    ];
    expect(await getRequiredPostMergeEvidenceDecision(storeFor(ir), taskWithRows(rows), undefined, landed()))
      .toEqual({ outcome: "blocked", gateId: GATE_ID, reason: "duplicate" });
  });
});

/*
FNXC:MergeGatePolicy 2026-11-02-18:16 (RUFU-450, adopting RUFU-430's rev.2 lesson):
The `engine-core` merge-gate vitest project resolves `@fusion/core` through the PRE-BUNDLED gate barrel
built from `index.gate.ts`, so a value export added only to `index.ts` passes every file-scoped lane (which
reaches source) and fails only `pnpm test:gate` — the exact defect RUFU-430's second round hit. Both
symbols the engine reads are values, so both barrels must carry them, and the identity check below is what
proves they are the same module rather than two copies that can drift.
*/
describe("producer-surface exports are exposed from BOTH core barrels", () => {
  it("re-exports the predicate and the episode seam from index.ts and index.gate.ts as one module instance", () => {
    expect(typeof fullBarrel.isPostMergeProducerUnreachable).toBe("function");
    expect(fullBarrel.isPostMergeProducerUnreachable).toBe(isPostMergeProducerUnreachable);
    expect(gateBarrel.isPostMergeProducerUnreachable).toBe(isPostMergeProducerUnreachable);
    expect(gateBarrel.decidePostMergeEvidenceRefusal).toBe(decidePostMergeEvidenceRefusal);
    expect(gateBarrel.postMergeEvidenceRefusalSignature).toBe(postMergeEvidenceRefusalSignature);
    expect(gateBarrel.readPostMergeEvidenceRefusalEpisode).toBe(readPostMergeEvidenceRefusalEpisode);
    expect(gateBarrel.POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY).toBe(POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY);
    expect(gateBarrel.POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS).toBe(POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS);
  });

  it("keeps the gate barrel's copy of the rule deciding the same way the source rule does", () => {
    expect(gateBarrel.isPostMergeProducerUnreachable({ surface: "ref-merged", mergeConfirmed: true, producerCanRun: false })).toBe(true);
    expect(gateBarrel.isPostMergeProducerUnreachable({ surface: "ref-divergent", mergeConfirmed: true, producerCanRun: false })).toBe(false);
  });
});
