/*
FNXC:UnrunPostMergeGateRecovery 2026-09-25-15:35 (RUFU-306):
A merge-confirmed card can sit in `in-review` forever because the enabled gate-mode post-merge group
never reported: the merge ran on the `merge-attempt` success edge, finalization refused, the run
ended, and nothing put the card back in front of the node. Measured on the production board
2026-09-25 as `Auto-merge finalization deferred for DGXS-313 / ROZV-290 … 'post-merge-verification'
has not reported`, with RUFU-220 and ROZV-286 parked the same way while their commits sat on `main`.

This lane must repair that WITHOUT three failure modes, and each has its own test below:
- it may not fabricate evidence — only a `missing` gate is seeded; an existing row carrying a real
  negative verdict is a review decision and re-running it would be a machine overruling a gate;
- it may not move the card — lifecycle containment (FN-207/FN-217) means the seeded continuation
  names the column the card actually stands in;
- it may not loop — finalize retries constantly, so the durable per-(task, gate) budget is what
  stops a gate that dies identically from burning model budget until the operator arrives.
*/
import { describe, expect, it, vi } from "vitest";
import { IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON, type Task, type TaskStore } from "@fusion/core";

import {
  MAX_POST_MERGE_GATE_RESEED_ATTEMPTS,
  STALE_CONTINUATION_RECLAIM_LOG_MARKER,
  findStaleRunningGateContinuations,
  isTerminalPostMergeReseedRefusal,
  postMergeGateReseedLogMarker,
  resumeMissingPostMergeGate,
} from "../merge/post-merge-gate-reseed.js";

const GATE_ID = "post-merge-verification";

const ir = {
  version: "v2",
  id: "builtin:coding",
  name: "Coding",
  nodes: [
    { id: "merge-attempt", kind: "action", column: "in-review" },
    {
      id: GATE_ID,
      kind: "optional-group",
      // The node's OWN column is the post-merge/complete lane — deliberately different from the
      // column the card stands in, so the in-place assertion below cannot pass by accident.
      column: "done",
      config: {
        phase: "post-merge",
        defaultOn: true,
        template: { nodes: [{ id: "post-merge-check", kind: "prompt", config: { gateMode: "gate" } }] },
      },
    },
  ],
  edges: [],
  columns: [
    { id: "in-review", label: "In review", traits: [] },
    { id: "done", label: "Done", traits: ["complete"] },
  ],
} as never;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-306",
    column: "in-review",
    title: "Landed but unfinalized",
    description: "",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    enabledWorkflowSteps: [GATE_ID],
    workflowStepResults: [],
    /*
    FNXC:PostMergeRecovery 2026-10-01-09:01: the merged guard is upstream's `mergeConfirmed` (FN-9442) — the
    SHA alone used to be this seam's proof, but every caller proves landing before asking, so the fixture
    carries the durable confirmation the real row carries.

    FNXC:UnrunPostMergeGateRecovery 2026-10-07-12:34 (RUFU-306): the fixture deliberately carries NO
    `commitSha`. A squash-merge cleanup or an external-land reconciliation writes
    `{ mergeConfirmed: true, mergedAt }` with no sha at all, and that card is still merged — the class the
    guard must admit. A default that always supplied a sha would leave the no-sha proof class unexercised
    and a re-added `commitSha` condition green; the pair with the unconfirmed-sha case below is what pins
    the guard's key, so neither condition may be re-added.
    */
    mergeDetails: { mergeConfirmed: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Task;
}

interface FakeOptions {
  seedResult?: { seeded: boolean; reason?: string };
  selectionReads?: boolean;
  /**
   * The DURABLE log, i.e. what `store.getTask` returns. Kept deliberately separate from the `task`
   * projection the caller hands the seam: the re-seed budget reads the former and a test that seeds
   * only the projection asserts the pre-RUFU-502 behavior.
   */
  durableLog?: Array<{ action: string }>;
  /**
   * Model the real append path: every marker the seam writes becomes visible to the NEXT durable read.
   * Without this, a growth test would have to hand-write each pass's log by hand.
   */
  accumulatesLog?: boolean;
  /** A hostile sink: the durable read itself fails, which must not read as "no attempts yet". */
  durableReadFails?: boolean;
}

function fakeStore(options: FakeOptions = {}) {
  const calls = {
    seed: [] as Array<Record<string, unknown>>,
    logged: [] as string[],
    audits: [] as Array<Record<string, unknown>>,
    selectionReads: 0,
  };
  const store = {
    getSettings: async () => ({}),
    getTaskWorkflowSelectionAsync: async () => null,
    getTaskWorkflowSelection: async () => null,
    getTaskWorkflowSelection: () => {
      if (options.selectionReads === false) return undefined;
      calls.selectionReads += 1;
      return { workflowId: "builtin:coding", stepIds: [] };
    },
    getWorkflowDefinition: async () => ({ ir }),
    listWorkflowWorkItemsForTask: async () => [],
    seedWorkspaceCodeReviewContinuationIfIdle: async (input: Record<string, unknown>) => {
      calls.seed.push(input);
      return options.seedResult ?? { seeded: true };
    },
    logEntry: async (_id: string, action: string) => { calls.logged.push(action); },
    recordRunAuditEvent: async (event: Record<string, unknown>) => { calls.audits.push(event); },
    /*
    FNXC:PostMergeReseedBudget 2026-10-03-07:12 (RUFU-502): the durable read, not the projection. The
    default `null` is the fake-store shape the counter treats as zero attempts; `accumulatesLog` makes
    the seam's own `logEntry` writes visible to the next read, the way production's append does.
    */
    getTask: async () => {
      if (options.durableReadFails) throw new Error("durable read unavailable");
      if (options.accumulatesLog) return { log: calls.logged.map((action) => ({ action })) };
      return options.durableLog ? { log: options.durableLog } : null;
    },
  };
  return { store: store as unknown as TaskStore, calls };
}

describe("resumeMissingPostMergeGate", () => {
  it("seeds the unreported gate in place, keeps the card's own column, and records one marker", async () => {
    const { store, calls } = fakeStore();

    const result = await resumeMissingPostMergeGate(store, task(), { source: "self-healing", contract: undefined });

    expect(result.outcome).toBe("seeded");
    expect(result.reason).toBe("seeded");
    expect(calls.seed).toHaveLength(1);
    const seed = calls.seed[0]!;
    expect(seed.nodeId).toBe(GATE_ID);
    expect(seed.state).toBe("runnable");
    // Lifecycle containment: the seed must name where the card actually stands, never a lane it is
    // being pushed back into.
    expect(seed.sourceColumn).toBe("in-review");
    expect(seed.targetColumn).toBe("in-review");
    expect(seed.targetColumn).not.toBe(ir.nodes[1].column);
    expect(calls.logged.filter((line) => line.startsWith(postMergeGateReseedLogMarker(GATE_ID)))).toHaveLength(1);
    expect(calls.audits.some((event) => event.mutationType === "task:merge-unrun-post-merge-gate-reseeded")).toBe(true);
  });

  it("refuses to re-run a gate that produced a real negative verdict", async () => {
    const { store, calls } = fakeStore();
    const decided = task({
      workflowStepResults: [{ workflowStepId: GATE_ID, status: "failed", verdict: "REVISE" }],
    } as never);

    const result = await resumeMissingPostMergeGate(store, decided, { source: "self-healing", contract: undefined });

    expect(result.outcome).toBe("not-seeded");
    expect(result.reason).toBe("gate-not-resumable");
    expect(calls.seed).toHaveLength(0);
    expect(calls.logged).toHaveLength(0);
  });

  /*
  FNXC:PostMergeReseedBudget 2026-10-03-07:12 (RUFU-502): the markers live in the DURABLE log. Before the
  fix this test passed markers through the `task` projection, which is exactly the shape production hands
  this lane (`listTasks({ slim: true })` answers `log: []`), so it was pinning the dead arm.
  */
  it("stops after the durable per-gate budget, because finalize retries forever", async () => {
    const marker = postMergeGateReseedLogMarker(GATE_ID);
    const spent = task();
    const { store, calls } = fakeStore({
      durableLog: Array.from({ length: MAX_POST_MERGE_GATE_RESEED_ATTEMPTS }, (_, index) => ({
        action: `${marker} attempt ${index}`,
      })),
    });

    const result = await resumeMissingPostMergeGate(store, spent, { source: "self-healing", contract: undefined });

    expect(result.reason).toBe("rerun-budget-exhausted");
    expect(result.priorAttemptCount).toBe(MAX_POST_MERGE_GATE_RESEED_ATTEMPTS);
    expect(calls.seed).toHaveLength(0);
  });

  /*
  FNXC:PostMergeReseedBudget 2026-10-03-07:12 (RUFU-502), Requirement 3:
  The card stands where a board read hands `log: []` while the durable log accumulates every marker the
  seam writes. The assertion is the GROWING counter, not an early refusal: with a ceiling of 3 the first
  three passes run (from durable states 0, 1, 2) and only the fourth is refused. Pre-fix every pass read
  zero, so all four seeded and each marker claimed `reseed 1 of 3`.
  */
  it("counts its own markers across passes when the board read hands an empty projection", async () => {
    const { store, calls } = fakeStore({ accumulatesLog: true });
    const slimCard = task({ log: [] } as never);

    const passes: Array<number | undefined> = [];
    for (let pass = 0; pass < MAX_POST_MERGE_GATE_RESEED_ATTEMPTS + 1; pass += 1) {
      const result = await resumeMissingPostMergeGate(store, slimCard, { source: "self-healing", contract: undefined });
      passes.push(result.priorAttemptCount);
      if (result.outcome !== "seeded") expect(result.reason).toBe("rerun-budget-exhausted");
    }

    expect(passes).toEqual([0, 1, 2, 3]);
    // Three seeds, then the fourth pass is refused: the ceiling is enforced, and enforced late enough
    // that a single flaky gate still gets its three real runs.
    expect(calls.seed).toHaveLength(MAX_POST_MERGE_GATE_RESEED_ATTEMPTS);
    // Requirement 2: the marker names the attempt it actually is, so the durable log cannot lie.
    expect(calls.logged.map((line) => line.match(/reseed (\d+) of (\d+)/)?.[0]))
      .toEqual(["reseed 1 of 3", "reseed 2 of 3", "reseed 3 of 3"]);
  });

  it("does not let another gate's durable markers spend this gate's budget", async () => {
    const otherGate = "post-merge-other-check";
    const { store, calls } = fakeStore({
      durableLog: [
        { action: `${postMergeGateReseedLogMarker(otherGate)}; (reseed 1 of 3)` },
        { action: `[post-merge-gate-reseed] gate '${otherGate}'` },
        { action: `[post-merge-gate-reseed] gate '${otherGate}' attempt 2` },
      ],
    });

    const result = await resumeMissingPostMergeGate(store, task(), { source: "self-healing", contract: undefined });

    expect(result.outcome).toBe("seeded");
    expect(result.priorAttemptCount).toBe(0);
    expect(calls.seed).toHaveLength(1);
  });

  /*
  FNXC:PostMergeReseedBudget 2026-10-03-08:13 (RUFU-502 review, finding F2):
  An unreadable durable row must not read as a fresh budget AND must not throw past the caller's batch
  loop: the seam answers with the named refusal, seeds nothing, and lets the next card in the pass run.
  It is deliberately NOT terminal — a later pass can read the row fine.
  */
  it("names an unreadable durable read instead of reading a fresh budget or cancelling the pass", async () => {
    const { store, calls } = fakeStore({ durableReadFails: true });

    const result = await resumeMissingPostMergeGate(store, task(), { source: "self-healing", contract: undefined });

    expect(result.outcome).toBe("not-seeded");
    expect(result.reason).toBe("durable-read-unavailable");
    expect(isTerminalPostMergeReseedRefusal(result.reason)).toBe(false);
    expect(calls.seed).toHaveLength(0);
    expect(calls.logged).toHaveLength(0);
  });

  it("treats every operator hold as absolute, and admits only the stall park it is undoing", async () => {
    const held = [
      task({ userPaused: true } as never),
      task({ paused: true, pausedReason: "operator-hold" } as never),
    ];
    for (const card of held) {
      const { store, calls } = fakeStore();
      const result = await resumeMissingPostMergeGate(store, card, { source: "self-healing", contract: undefined });
      expect(result.reason).toBe("operator-held");
      expect(calls.seed).toHaveLength(0);
    }

    /*
    FNXC:PostMergeCloseout 2026-10-13-07:51 (merge origin/main):
    Both halves of the auto-merge decision are pinned here, because the two signals are different kinds of
    thing. PROJECT auto-merge Off still holds the whole lane (FN-5147: `in-review` is human-terminal), so the
    seam must refuse it. A per-card `autoMerge: false` no longer does — that value is often inherited or
    engine-authored (FN-6444) and the card reaching this seam has a durable landing already proven, so what
    remains is closeout, not a landing decision. The per-card case used to sit in the absolute-holds list
    above; asserting it as admitted is what keeps the removal from silently unpinning either side.
    */
    const projectOff = fakeStore();
    (projectOff.store as unknown as { getSettings: () => Promise<Record<string, unknown>> }).getSettings
      = async () => ({ autoMerge: false });
    expect((await resumeMissingPostMergeGate(projectOff.store, task(), { source: "self-healing", contract: undefined })).reason)
      .toBe("engine-paused");
    expect(projectOff.calls.seed).toHaveLength(0);

    const perCardFalse = fakeStore();
    expect((await resumeMissingPostMergeGate(perCardFalse.store, task({ autoMerge: false } as never), { source: "self-healing", contract: undefined })).outcome)
      .not.toBe("operator-held");

    const parkedByOurOwnLane = task({ paused: true, pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON } as never);
    const admitted = fakeStore();
    expect((await resumeMissingPostMergeGate(admitted.store, parkedByOurOwnLane, { source: "self-healing", contract: undefined })).outcome).toBe("seeded");
  });

  /*
  FNXC:UnrunPostMergeGateRecovery 2026-10-07-12:34 (RUFU-306):
  Proof-class regression lock. The refusal this lane exists to stop was silent, and the shape that made it
  silent was a card that was genuinely merged but held no local `commitSha`. These two cases pin both sides
  of the guard's key: the confirmation admits, the SHA alone does not, and a refusal that cannot seed may
  not even begin workflow resolution.
  */
  it("seeds from a merge confirmation that carries no commitSha, because a landed card need not", async () => {
    const noSha = task({ mergeDetails: { mergeConfirmed: true, mergedAt: new Date().toISOString() } as never });
    expect(noSha.mergeDetails?.commitSha).toBeUndefined();
    const { store, calls } = fakeStore();

    const result = await resumeMissingPostMergeGate(store, noSha, { source: "manual-reconcile", contract: undefined });

    expect(result.outcome).toBe("seeded");
    expect(calls.seed).toHaveLength(1);
    expect(calls.seed[0]).toMatchObject({ nodeId: GATE_ID, targetColumn: "in-review" });
  });

  it("refuses a bare commitSha that carries no merge confirmation, without touching the graph", async () => {
    const unconfirmed = task({
      mergeDetails: { commitSha: "c1321d86936e6187ff8b5c769d2c15e204c4a3cb" } as never,
    });
    const { store, calls } = fakeStore();

    const result = await resumeMissingPostMergeGate(store, unconfirmed, { source: "manual-reconcile", contract: undefined });

    expect(result.reason).toBe("no-merge-proof");
    expect(calls.seed).toHaveLength(0);
    expect(calls.logged).toHaveLength(0);
    // An unconfirmed sha must not even start workflow resolution — the guard runs first.
    expect(calls.selectionReads).toBe(0);
  });

  it("demands landed proof before touching the graph, and stays silent without a selection read", async () => {
    const withoutProof = fakeStore();
    expect((await resumeMissingPostMergeGate(withoutProof.store, task({ mergeDetails: {} } as never), { source: "self-healing", contract: undefined })).reason)
      .toBe("no-merge-proof");
    // An empty mergeDetails object must not even start workflow resolution.
    expect(withoutProof.calls.selectionReads).toBe(0);

    const blind = fakeStore({ selectionReads: false });
    const blindStore = Object.assign(blind.store, { getTaskWorkflowSelection: undefined }) as unknown as TaskStore;
    expect((await resumeMissingPostMergeGate(blindStore, task(), { source: "self-healing", contract: undefined })).reason).toBe("gate-not-resumable");
  });

  it("reports an idle-seed refusal as a refusal and logs no budget marker", async () => {
    const { store, calls } = fakeStore({ seedResult: { seeded: false, reason: "active-continuation" } });

    const result = await resumeMissingPostMergeGate(store, task(), { source: "self-healing", contract: undefined });

    expect(result.outcome).toBe("not-seeded");
    expect(result.reason).toBe("active-continuation");
    expect(calls.logged).toHaveLength(0);
    expect(calls.audits).toHaveLength(0);
  });
});

/*
FNXC:PostMergeRecovery 2026-10-09-15:20 (RUFU-610):
The safety of the reclaim lives entirely in this predicate, because the write it enables (retire + seed) is not
self-limiting. Measured production shape: `leaseOwner = planning-continuation-dispatch:<id>:0`,
`lease_expires_at IS NULL`, `updated_at` 6,6-10,7 h old, exactly one such row per stuck card.
*/
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const zombieRow = (overrides: Record<string, unknown> = {}) => ({
  id: "wi-zombie",
  kind: "task",
  nodeId: GATE_ID,
  state: "running",
  leaseExpiresAt: null,
  updatedAt: hoursAgo(7),
  ...overrides,
});

describe("findStaleRunningGateContinuations", () => {
  it("reclaims this gate's own leaseless running row once it is past the floor", () => {
    expect(findStaleRunningGateContinuations([zombieRow()] as never, GATE_ID).map((i) => i.id)).toEqual(["wi-zombie"]);
  });

  it("reclaims a row whose lease already expired, because an expired lease proves no owner", () => {
    expect(findStaleRunningGateContinuations([zombieRow({ leaseExpiresAt: hoursAgo(3) })] as never, GATE_ID)).toHaveLength(1);
  });

  it("leaves a row that still holds a live lease", () => {
    const items = [zombieRow({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })];
    expect(findStaleRunningGateContinuations(items as never, GATE_ID)).toEqual([]);
  });

  it("leaves a row younger than the floor, which is ordinary in-flight work", () => {
    expect(findStaleRunningGateContinuations([zombieRow({ updatedAt: hoursAgo(0.5) })] as never, GATE_ID)).toEqual([]);
  });

  it("leaves a row whose write timestamp is unreadable, because an unprovable age is not proof of death", () => {
    expect(findStaleRunningGateContinuations([zombieRow({ updatedAt: null })] as never, GATE_ID)).toEqual([]);
  });

  it("refuses the pass when any active row belongs to a different node", () => {
    // Retiring a reviewer that is live on another node is not this lane's decision to make.
    const items = [zombieRow(), zombieRow({ id: "wi-review", nodeId: "code-review" })];
    expect(findStaleRunningGateContinuations(items as never, GATE_ID)).toEqual([]);
  });

  it.each(["held", "retrying", "runnable"] as const)(
    "refuses a %s row: only an ownerless running row is dead work", (state) => {
      expect(findStaleRunningGateContinuations([zombieRow({ state })] as never, GATE_ID)).toEqual([]);
    },
  );

  it("says nothing when the card holds no active continuation", () => {
    expect(findStaleRunningGateContinuations([zombieRow({ state: "succeeded" })] as never, GATE_ID)).toEqual([]);
  });
});

describe("resumeMissingPostMergeGate stale continuation reclaim", () => {
  it("retires the gate's own ownerless running row and seeds, instead of refusing not-idle", async () => {
    const { store, calls } = fakeStore();
    const transitions: Array<{ id: string; state: string; patch: Record<string, unknown> }> = [];
    Object.assign(store, {
      listWorkflowWorkItemsForTask: async () => [zombieRow()],
      transitionWorkflowWorkItem: async (id: string, state: string, patch: Record<string, unknown> = {}) => {
        transitions.push({ id, state, patch });
        return { id, state };
      },
    });

    const result = await resumeMissingPostMergeGate(store, task(), { source: "manual-reconcile", contract: undefined });

    expect(result.outcome).toBe("seeded");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      id: "wi-zombie",
      state: "failed",
      patch: { lastError: "stale-running-continuation-reclaimed", leaseOwner: null, leaseExpiresAt: null },
    });
    expect(calls.seed).toHaveLength(1);
    expect(calls.logged.some((line) => line.includes("retired 1 abandoned running continuation"))).toBe(true);
    // A reclaim is not an attempt: only the seam's own counted marker may charge the budget.
    expect(calls.logged.filter((line) => line.startsWith(postMergeGateReseedLogMarker(GATE_ID)))).toHaveLength(1);
    expect(STALE_CONTINUATION_RECLAIM_LOG_MARKER).not.toBe(postMergeGateReseedLogMarker(GATE_ID));
  });

  it("does not retire another node's running row, and still reports the idle-seed refusal", async () => {
    const { store } = fakeStore({ seedResult: { seeded: false, reason: "active-continuation" } });
    const transitions: string[] = [];
    Object.assign(store, {
      listWorkflowWorkItemsForTask: async () => [zombieRow({ id: "wi-review", nodeId: "code-review" })],
      transitionWorkflowWorkItem: async (id: string) => { transitions.push(id); return { id }; },
    });

    const result = await resumeMissingPostMergeGate(store, task(), { source: "manual-reconcile", contract: undefined });

    expect(result.reason).toBe("active-continuation");
    expect(transitions).toEqual([]);
  });
});
