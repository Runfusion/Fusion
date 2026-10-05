import { describe, expect, it, vi } from "vitest";
import type { PrEntity, PrReadinessSnapshot, TaskDetail } from "@fusion/core";

import { createAutoMergeGateHandler } from "../merge/pr-nodes.js";
import { ProjectEngine, resolveExternalMergeCloseoutNode } from "../project-engine.js";
import { deriveTransitions, PrReconciler } from "../merge/pr-reconcile.js";

function readiness(overrides: Partial<PrReadinessSnapshot> = {}): PrReadinessSnapshot {
  return {
    observedHeadOid: "head-a",
    baseOid: "base-a",
    headBehindBase: false,
    requiredChecks: [{ name: "build", state: "success" }],
    approval: "approved",
    mergeable: "clean",
    protectionBlockers: [],
    state: "open",
    deployments: { state: "supported" },
    branchUpdate: { state: "supported" },
    checks: { state: "supported" },
    reviews: { state: "supported" },
    merge: { state: "supported" },
    observedAt: "2026-10-04T23:37:00.000Z",
    ...overrides,
  };
}

function entity(readinessSnapshot: PrReadinessSnapshot): PrEntity {
  return {
    id: "PR-readiness",
    sourceType: "task",
    sourceId: "FN-9439",
    repo: "owner/repo",
    headBranch: "feature/readiness",
    state: "open",
    headOid: "head-a",
    readiness: readinessSnapshot,
    autoMerge: true,
    mergeable: "clean",
    checksRollup: "success",
    reviewDecision: "APPROVED",
    unverified: false,
    responseRounds: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function invoke(entityResult: PrEntity) {
  const getActivePrEntityBySource = vi.fn(async () => entityResult);
  const handler = createAutoMergeGateHandler({
    getStore: () => ({ getActivePrEntityBySource }) as never,
  });
  return handler(
    { id: "auto-merge", kind: "auto-merge" } as never,
    { task: { id: "FN-9439" } as TaskDetail } as never,
  );
}

describe("PR readiness reconciliation", () => {
  it("releases a durable wait only when a current-head observation becomes ready", () => {
    const pending = readiness({ requiredChecks: [{ name: "build", state: "pending" }] });
    const transitions = deriveTransitions(entity(pending), {
      exists: true,
      prState: "open",
      headOid: "head-a",
      readiness: readiness(),
      readinessProvider: "github",
    });
    expect(transitions).toContainEqual(expect.objectContaining({ event: "ready", tag: "github:pr-ready" }));

    const stale = deriveTransitions(entity(pending), {
      exists: true,
      prState: "open",
      headOid: "head-b",
      readiness: readiness({ observedHeadOid: "head-a" }),
      readinessProvider: "github",
    });
    expect(stale.some((transition) => transition.event === "ready")).toBe(false);
  });

});

describe("external current-head merge reconciliation", () => {
  it("hands a fresh matching merged head to closeout before generic release", async () => {
    const active = { ...entity(readiness()), prNumber: 17 };
    const order: string[] = [];
    const reconciler = new PrReconciler({
      store: {
        listActivePrEntities: async () => [active],
        getPrEntity: async () => active,
        updatePrEntity: async () => active,
        updatePrReadiness: async () => active,
      },
      ops: {
        probe: async () => ({ changed: true }),
        fetchPrState: async () => ({
          exists: true,
          prState: "merged",
          headOid: "head-a",
          readiness: readiness({ state: "merged", mergeCommitSha: "merge-a", mergeCommitIncludesHead: true }),
        }),
      },
      onMergedCurrentHead: async () => { order.push("closeout"); return true; },
      releaseByEvent: async () => { order.push("release"); },
    });

    await reconciler.reconcileRepoOnce("owner/repo");

    expect(order).toEqual(["closeout"]);
  });

  it("does not replace continuation or clear a paused task", async () => {
    const active = { ...entity(readiness()), prNumber: 17 };
    const task = {
      id: "FN-9439",
      paused: true,
      prInfo: { number: 17, headOid: "head-a", status: "open" },
    };
    const updatePrInfo = vi.fn();
    const store = {
      getTask: vi.fn(async () => task),
      getActivePrEntityBySource: vi.fn(async () => active),
      withPlanningLifecycleLock: async (_id: string, fn: () => Promise<void>) => fn(),
      updatePrInfo,
    };
    const engine = Object.assign(Object.create(ProjectEngine.prototype), {
      runtime: { getTaskStore: () => store },
      isMergePending: async () => false,
    }) as ProjectEngine;

    const accepted = await engine.reconcileDashboardMergedPr("FN-9439", {
      exists: true,
      prState: "merged",
      prNumber: 17,
      headOid: "head-a",
      readiness: readiness({ state: "merged", mergeCommitSha: "merge-a", mergeCommitIncludesHead: true }),
    });

    expect(accepted).toBe(false);
    expect(updatePrInfo).not.toHaveBeenCalled();
  });

  it("keeps an unknown runnable continuation owned by its existing route", async () => {
    const active = { ...entity(readiness()), prNumber: 17 };
    const task = {
      id: "FN-9439",
      column: "in-review",
      prInfo: { number: 17, headOid: "head-a", status: "open" },
    };
    const replaceActiveTaskWorkflowContinuation = vi.fn();
    const store = {
      getTask: vi.fn(async () => task),
      getActivePrEntityBySource: vi.fn(async () => active),
      withPlanningLifecycleLock: async <T>(_id: string, fn: () => Promise<T>) => fn(),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "WF-closeout" })),
      getWorkflowDefinition: vi.fn(async () => ({ ir: {
        version: "v2",
        name: "external-closeout",
        columns: [],
        nodes: [
          { id: "merge", kind: "merge-attempt" },
          { id: "closeout", kind: "optional-group", config: { phase: "post-merge" } },
          { id: "foreign", kind: "end" },
        ],
        edges: [{ from: "merge", to: "closeout", condition: "success" }],
      } })),
      listWorkflowWorkItemsForTask: vi.fn(async () => [{ nodeId: "foreign", state: "runnable" }]),
      updatePrInfo: vi.fn(),
      replaceActiveTaskWorkflowContinuation,
    };
    const engine = Object.assign(Object.create(ProjectEngine.prototype), {
      runtime: { getTaskStore: () => store },
      isMergePending: async () => false,
    }) as ProjectEngine;

    await expect(engine.reconcileDashboardMergedPr("FN-9439", {
      exists: true,
      prState: "merged",
      prNumber: 17,
      headOid: "head-a",
      readiness: readiness({ state: "merged", mergeCommitSha: "merge-a", mergeCommitIncludesHead: true }),
    })).resolves.toBe(false);

    expect(store.updatePrInfo).not.toHaveBeenCalled();
    expect(replaceActiveTaskWorkflowContinuation).not.toHaveBeenCalled();
  });

  it("serializes two store instances so only one closeout handoff is published", async () => {
    const active = { ...entity(readiness()), prNumber: 17 };
    const task = {
      id: "FN-9439",
      column: "in-review",
      prInfo: { number: 17, headOid: "head-a", status: "open" },
      mergeDetails: {},
    };
    const ir = {
      version: "v2",
      name: "external-closeout",
      columns: [],
      nodes: [
        { id: "merge", kind: "merge-attempt" },
        { id: "closeout", kind: "optional-group", config: { phase: "post-merge" } },
      ],
      edges: [{ from: "merge", to: "closeout", condition: "success" }],
    };
    let lockTail = Promise.resolve();
    const withPlanningLifecycleLock = async <T>(_id: string, fn: () => Promise<T>) => {
      const prior = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        return await fn();
      } finally {
        release();
      }
    };
    const workItems: Array<{ nodeId: string; state: "runnable" }> = [];
    const replaceActiveTaskWorkflowContinuation = vi.fn(async (item: { nodeId: string; state: "runnable" }) => {
      workItems.splice(0, workItems.length, item);
    });
    const updateTask = vi.fn(async (_id: string, patch: object) => Object.assign(task, patch));
    const updatePrInfo = vi.fn(async (_id: string, prInfo: object) => Object.assign(task, { prInfo }));
    const createStore = () => ({
      getTask: vi.fn(async () => task),
      getActivePrEntityBySource: vi.fn(async () => active),
      withPlanningLifecycleLock,
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "WF-closeout" })),
      getWorkflowDefinition: vi.fn(async () => ({ ir })),
      listWorkflowWorkItemsForTask: vi.fn(async () => workItems),
      updatePrInfo,
      updateTask,
      replaceActiveTaskWorkflowContinuation,
    });
    const createEngine = () => Object.assign(Object.create(ProjectEngine.prototype), {
      runtime: { getTaskStore: createStore, getExecutor: () => undefined },
      isMergePending: async () => false,
    }) as ProjectEngine;
    const result = {
      exists: true as const,
      prState: "merged" as const,
      prNumber: 17,
      headOid: "head-a",
      readiness: readiness({ state: "merged", mergeCommitSha: "merge-a", mergeCommitIncludesHead: true }),
    };

    const outcomes = await Promise.all([
      createEngine().reconcileDashboardMergedPr("FN-9439", result),
      createEngine().reconcileDashboardMergedPr("FN-9439", result),
    ]);

    expect(outcomes).toEqual([true, false]);
    expect(replaceActiveTaskWorkflowContinuation).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledOnce();
  });

  it("retries a deferred merged landing after a paused owner resumes without releasing stale work", async () => {
    const active = { ...entity(readiness()), prNumber: 17 };
    const releaseByEvent = vi.fn(async () => undefined);
    const onMergedCurrentHead = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const updatePrReadiness = vi.fn(async (
      _id: string,
      _head: string | undefined,
      _provider: string,
      snapshot: PrReadinessSnapshot,
      options?: { deferMergedTerminalState?: boolean },
    ) => {
      active.readiness = snapshot;
      if (!options?.deferMergedTerminalState) active.state = snapshot.state;
      return active;
    });
    const updatePrEntity = vi.fn(async (_id: string, patch: Partial<PrEntity>) => {
      Object.assign(active, patch);
      return active;
    });
    const reconciler = new PrReconciler({
      store: {
        listActivePrEntities: async () => active.state === "open" ? [active] : [],
        getPrEntity: async () => active,
        updatePrEntity,
        updatePrReadiness,
      },
      ops: {
        probe: vi.fn()
          .mockResolvedValueOnce({ changed: true })
          .mockResolvedValueOnce({ changed: false }),
        fetchPrState: async () => ({
          exists: true,
          prState: "merged",
          headOid: "head-a",
          readiness: readiness({ state: "merged", mergeCommitSha: "merge-a", mergeCommitIncludesHead: true }),
        }),
      },
      onMergedCurrentHead,
      releaseByEvent,
    });

    await reconciler.reconcileAllOnce();
    await reconciler.reconcileAllOnce();

    expect(onMergedCurrentHead).toHaveBeenCalledTimes(2);
    expect(updatePrReadiness).toHaveBeenNthCalledWith(1, expect.anything(), "head-a", "github", expect.anything(), {
      deferMergedTerminalState: true,
    });
    expect(updatePrEntity).toHaveBeenCalledWith("PR-readiness", { state: "merged" });
    expect(active.state).toBe("merged");
    expect(releaseByEvent).not.toHaveBeenCalled();
  });

  it("does not repeat closeout after the merged entity becomes terminal", async () => {
    const active = { ...entity(readiness()), prNumber: 17 };
    const onMergedCurrentHead = vi.fn(async () => true);
    const reconciler = new PrReconciler({
      store: {
        listActivePrEntities: async () => [active],
        getPrEntity: async () => active,
        updatePrEntity: async () => active,
        updatePrReadiness: async () => {
          active.state = "merged";
          return active;
        },
      },
      ops: {
        probe: async () => ({ changed: true }),
        fetchPrState: async () => ({
          exists: true,
          prState: "merged",
          headOid: "head-a",
          readiness: readiness({ state: "merged", mergeCommitSha: "merge-a", mergeCommitIncludesHead: true }),
        }),
      },
      onMergedCurrentHead,
    });

    await reconciler.reconcileRepoOnce("owner/repo");
    await reconciler.reconcileRepoOnce("owner/repo");

    expect(onMergedCurrentHead).toHaveBeenCalledOnce();
  });

  it("selects only a success-reachable post-merge graph node", () => {
    const closeout = resolveExternalMergeCloseoutNode({
      version: "v2",
      id: "external-closeout",
      name: "external-closeout",
      columns: [],
      nodes: [
        { id: "merge", kind: "merge-attempt" },
        { id: "post-merge-check", kind: "optional-group", config: { phase: "post-merge" } },
        { id: "retry", kind: "retry-backoff" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "merge", to: "retry", condition: "failure" },
        { from: "merge", to: "post-merge-check", condition: "success" },
        { from: "merge", to: "end", condition: "success" },
      ],
    } as never);

    expect(closeout).toBe("post-merge-check");
  });

  it("does not select ordinary success nodes after the merge boundary", () => {
    const closeout = resolveExternalMergeCloseoutNode({
      version: "v2",
      id: "ordinary-success-node",
      name: "ordinary-success-node",
      columns: [],
      nodes: [
        { id: "merge", kind: "merge-attempt" },
        { id: "implementation", kind: "step-execute" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "merge", to: "implementation", condition: "success" },
        { from: "implementation", to: "end", condition: "success" },
      ],
    } as never);

    expect(closeout).toBeUndefined();
  });

  it.each([
    readiness({ state: "closed" }),
    readiness({ observedHeadOid: "other-head", state: "merged", mergeCommitSha: "merge-a" }),
    readiness({ state: "merged" }),
    readiness({ state: "merged", mergeCommitSha: "merge-a" }),
    readiness({ state: "merged", mergeCommitSha: "merge-a", mergeCommitIncludesHead: false }),
  ])("does not close out an unproven current-head observation", async (snapshot) => {
    const active = { ...entity(readiness()), prNumber: 17 };
    const onMergedCurrentHead = vi.fn(async () => true);
    const reconciler = new PrReconciler({
      store: {
        listActivePrEntities: async () => [active],
        getPrEntity: async () => active,
        updatePrEntity: async () => active,
        updatePrReadiness: async () => active,
      },
      ops: {
        probe: async () => ({ changed: true }),
        fetchPrState: async () => ({ exists: true, prState: "merged", headOid: "head-a", readiness: snapshot }),
      },
      onMergedCurrentHead,
    });

    await reconciler.reconcileRepoOnce("owner/repo");

    expect(onMergedCurrentHead).not.toHaveBeenCalled();
  });
});

describe("PR readiness auto-merge admission", () => {
  it("refuses legacy-green evidence fenced to a stale head", async () => {
    const result = await invoke({ ...entity(readiness()), headOid: "head-b" });

    expect(result).toMatchObject({ outcome: "success", value: "auto-off" });
  });

  it("refuses legacy-green evidence with an unsupported provider capability", async () => {
    const result = await invoke(entity(readiness({ deployments: { state: "unsupported" } })));

    expect(result).toMatchObject({ outcome: "success", value: "auto-off" });
  });

  it("admits a complete supported observation for the current head", async () => {
    const result = await invoke(entity(readiness()));

    expect(result).toMatchObject({ outcome: "success", value: "auto-on" });
  });
});
