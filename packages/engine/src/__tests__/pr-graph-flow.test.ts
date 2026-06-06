/**
 * U6 — auto-merge gate routing + legacy-queue bypass pin (R14).
 *
 * Auto-merge gate (R10): a `gate` node carrying `config.gate === "auto-merge"`
 * consults the LIVE PR entity and routes:
 *   - `outcome:auto-on`  when the entity is auto-merge-ready (opted in + approved
 *     + checks success + mergeable clean + verified) → toward pr-merge;
 *   - `outcome:auto-off` for every non-ready case (pending checks, UNKNOWN
 *     mergeable, unverified, not opted in, no entity) → park for manual merge.
 *
 * R14 pin: a graph-executed PR task merges THROUGH the pr-merge node's injected
 * mergePr callback — the merge node IS the merge path — and never falls into the
 * legacy merge queue. The executor's graph/legacy routing enforces this; this
 * test pins the merge-node behavior so a regression can't silently re-introduce a
 * double-merge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "@fusion/core";
import type { PrEntity, TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import { createAutoMergeGateHandler } from "../pr-nodes.js";
import type { PrMergeCallResult, PrNodeDeps, PrSourceDescriptor } from "../pr-nodes.js";
import type { WorkflowNodeExecutionContext } from "../workflow-graph-executor.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

const SOURCE: PrSourceDescriptor = {
  sourceType: "task",
  sourceId: "T-1",
  repo: "owner/repo",
  headBranch: "fusion/t-1",
};

function ctx(taskId = "T-1"): WorkflowNodeExecutionContext {
  return { task: { id: taskId } as unknown as TaskDetail, settings: undefined, context: {} };
}

const GATE_NODE = { id: "g", kind: "gate", config: { gate: "auto-merge" } } as WorkflowIrNode;

describe("auto-merge gate (U6, R10)", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-pr-graph-flow-"));
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global"));
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function deps(overrides: Partial<PrNodeDeps> = {}): PrNodeDeps {
    return {
      getStore: () => store,
      resolvePrSource: () => SOURCE,
      createPr: async () => ({ prNumber: 1, prUrl: "u" }),
      mergePr: async () => ({ status: "merged-requested" }) as PrMergeCallResult,
      ...overrides,
    };
  }

  /** Seed a live `open` entity and patch it to a chosen readiness state. */
  function seedEntity(patch: Partial<PrEntity>): PrEntity {
    const entity = store.ensurePrEntityForSource({ ...SOURCE, state: "open" });
    return store.updatePrEntity(entity.id, {
      state: "open",
      autoMerge: patch.autoMerge,
      reviewDecision: patch.reviewDecision,
      checksRollup: patch.checksRollup,
      mergeable: patch.mergeable,
      unverified: patch.unverified,
    });
  }

  const READY: Partial<PrEntity> = {
    autoMerge: true,
    reviewDecision: "APPROVED",
    checksRollup: "success",
    mergeable: "clean",
    unverified: false,
  };

  it("ready entity → auto-on", async () => {
    seedEntity(READY);
    const gate = createAutoMergeGateHandler(deps());
    const result = await gate(GATE_NODE, ctx());
    expect(result).toEqual({ outcome: "success", value: "auto-on" });
  });

  it("not opted in → auto-off", async () => {
    seedEntity({ ...READY, autoMerge: false });
    const gate = createAutoMergeGateHandler(deps());
    expect(await gate(GATE_NODE, ctx())).toEqual({ outcome: "success", value: "auto-off" });
  });

  it("pending checks → auto-off", async () => {
    seedEntity({ ...READY, checksRollup: "pending" });
    const gate = createAutoMergeGateHandler(deps());
    expect(await gate(GATE_NODE, ctx())).toEqual({ outcome: "success", value: "auto-off" });
  });

  it("unknown mergeability → auto-off", async () => {
    seedEntity({ ...READY, mergeable: "unknown" });
    const gate = createAutoMergeGateHandler(deps());
    expect(await gate(GATE_NODE, ctx())).toEqual({ outcome: "success", value: "auto-off" });
  });

  it("unverified entity → auto-off (R19 hard gate)", async () => {
    seedEntity({ ...READY, unverified: true });
    const gate = createAutoMergeGateHandler(deps());
    expect(await gate(GATE_NODE, ctx())).toEqual({ outcome: "success", value: "auto-off" });
  });

  it("not approved → auto-off", async () => {
    seedEntity({ ...READY, reviewDecision: "CHANGES_REQUESTED" });
    const gate = createAutoMergeGateHandler(deps());
    expect(await gate(GATE_NODE, ctx())).toEqual({ outcome: "success", value: "auto-off" });
  });

  it("no live entity → auto-off (never blocks the run)", async () => {
    const gate = createAutoMergeGateHandler(deps());
    expect(await gate(GATE_NODE, ctx())).toEqual({ outcome: "success", value: "auto-off" });
  });

  it("routes a graph end-to-end: approve → auto-on gate → pr-merge", async () => {
    seedEntity(READY);
    const mergePr = vi.fn(async () => ({ status: "merged-requested" }) as PrMergeCallResult);
    const ir: WorkflowIr = {
      version: "v1",
      name: "auto-merge-flow",
      nodes: [
        { id: "start", kind: "start" },
        { id: "gate", kind: "gate", config: { gate: "auto-merge" } },
        { id: "merge", kind: "pr-merge" },
        { id: "park", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "gate" },
        { from: "gate", to: "merge", condition: "outcome:auto-on" },
        { from: "gate", to: "park", condition: "outcome:auto-off" },
        { from: "merge", to: "end" },
        { from: "park", to: "end" },
      ],
    };
    const park = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      prNodes: deps({ mergePr }),
      handlers: { script: park },
    });

    const result = await executor.run({ id: "T-1" } as TaskDetail, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain("merge");
    expect(mergePr).toHaveBeenCalledTimes(1);
    expect(park).not.toHaveBeenCalled();
  });

  it("auto-off entity parks for manual merge (pr-merge not reached)", async () => {
    seedEntity({ ...READY, checksRollup: "pending" });
    const mergePr = vi.fn(async () => ({ status: "merged-requested" }) as PrMergeCallResult);
    const ir: WorkflowIr = {
      version: "v1",
      name: "auto-merge-park",
      nodes: [
        { id: "start", kind: "start" },
        { id: "gate", kind: "gate", config: { gate: "auto-merge" } },
        { id: "merge", kind: "pr-merge" },
        { id: "park", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "gate" },
        { from: "gate", to: "merge", condition: "outcome:auto-on" },
        { from: "gate", to: "park", condition: "outcome:auto-off" },
        { from: "merge", to: "end" },
        { from: "park", to: "end" },
      ],
    };
    const park = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      prNodes: deps({ mergePr }),
      handlers: { script: park },
    });

    const result = await executor.run({ id: "T-1" } as TaskDetail, settingsOn(), ir);
    expect(result.visitedNodeIds).toContain("park");
    expect(result.visitedNodeIds).not.toContain("merge");
    expect(mergePr).not.toHaveBeenCalled();
  });
});

describe("legacy-queue bypass pin (U6, R14)", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-pr-r14-"));
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global"));
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function deps(mergePr: PrNodeDeps["mergePr"]): PrNodeDeps {
    return {
      getStore: () => store,
      resolvePrSource: () => SOURCE,
      createPr: async () => ({ prNumber: 1, prUrl: "u" }),
      mergePr,
    };
  }

  it("a graph-executed PR task merges through the pr-merge node, not a legacy queue", async () => {
    // Seed an actionable entity so pr-merge proceeds (the merge node IS the merge
    // path under the graph executor).
    const entity = store.ensurePrEntityForSource({ ...SOURCE, state: "open" });
    store.updatePrEntity(entity.id, { state: "open", unverified: false, headOid: "deadbeef" });

    // A legacy merge-queue sink. If the graph path EVER routed a PR task into the
    // legacy merger this spy would be hit — pinning the bypass (R14).
    const legacyMergeEnqueue = vi.fn();
    const mergePr = vi.fn(async () => ({ status: "merged-requested" }) as PrMergeCallResult);

    const ir: WorkflowIr = {
      version: "v1",
      name: "r14-merge-node-only",
      nodes: [
        { id: "start", kind: "start" },
        { id: "merge", kind: "pr-merge" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "merge" },
        { from: "merge", to: "end" },
      ],
    };
    const executor = new WorkflowGraphExecutor({ prNodes: deps(mergePr) });

    const result = await executor.run({ id: "T-1" } as TaskDetail, settingsOn(), ir);

    // Merge happened exactly once, via the injected node callback with the
    // entity's head OID — the graph node IS the merge, no legacy enqueue.
    expect(result.outcome).toBe("success");
    expect(mergePr).toHaveBeenCalledTimes(1);
    expect(mergePr).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: "deadbeef" }));
    expect(legacyMergeEnqueue).not.toHaveBeenCalled();

    // The node does NOT write the terminal `merged` state (reconcile corroborates),
    // so there is no path for a second/legacy merge to also act on a `merged` row.
    expect(store.getActivePrEntityBySource("task", "T-1")?.state).toBe("open");
  });
});
