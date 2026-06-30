/**
 * U3 — PR node handlers (pr-create / pr-respond / pr-merge).
 *
 * Covers: pr-create success→open, pr-create failure→failed (routable, never
 * throws), create idempotent re-entry, pr-merge stale-head→value:"stale-head"
 * with no `merged` write, pr-merge does-not-write-merged on success, unverified
 * entity not actioned, and unwired deps fail closed (value:"pr-nodes-unwired").
 *
 * The handlers run against a real in-memory TaskStore (U1 store CRUD) and fakes
 * for the injected GitHub callbacks — the engine never touches a real client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "@fusion/core";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import {
  buildRespondCallback,
  createPrNodeHandlers,
  type PrMergeCallResult,
  type PrNodeDeps,
  type PrRespondGithubOps,
  type PrSourceDescriptor,
} from "../pr-nodes.js";
import type { PrEntity } from "@fusion/core";
import { createDefaultNodeHandlers, createNoopLegacySeams } from "../workflow-node-handlers.js";
import type { WorkflowNodeExecutionContext } from "../workflow-graph-executor.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fusion-pr-nodes-test-"));
}

const SOURCE: PrSourceDescriptor = {
  sourceType: "task",
  sourceId: "T-1",
  repo: "owner/repo",
  headBranch: "fusion/t-1",
};

function ctx(taskId = "T-1"): WorkflowNodeExecutionContext {
  return {
    task: { id: taskId } as unknown as TaskDetail,
    settings: undefined,
    context: {},
  };
}

const NODE = { id: "n", kind: "pr-create" } as WorkflowIrNode;

describe("PR node handlers (U3)", () => {
  let rootDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
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
      createPr: async () => ({ prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42", headOid: "abc123" }),
      mergePr: async () => ({ status: "merged-requested" }) as PrMergeCallResult,
      ...overrides,
    };
  }

  it("pr-create success → entity open with persisted PR fields, value:open", async () => {
    const updatePrInfo = vi.spyOn(store, "updatePrInfo").mockResolvedValue({ id: "T-1" } as any);
    const handlers = createPrNodeHandlers(deps());
    const result = await handlers["pr-create"](NODE, ctx());
    expect(result).toEqual({ outcome: "success", value: "open" });

    const entity = store.getActivePrEntityBySource("task", "T-1");
    expect(entity?.state).toBe("open");
    expect(entity?.prNumber).toBe(42);
    expect(entity?.prUrl).toBe("https://github.com/owner/repo/pull/42");
    expect(entity?.headOid).toBe("abc123");
    expect(updatePrInfo).toHaveBeenCalledWith("T-1", expect.objectContaining({
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open",
      headBranch: "fusion/t-1",
      baseBranch: "main",
      manual: true,
    }));
  });

  it("pr-create failure → entity failed + failureReason, value:failed (routable, never throws)", async () => {
    // Pre-create the entity so we hold its id (the failed row leaves the active set).
    const seeded = store.ensurePrEntityForSource(SOURCE);
    const handlers = createPrNodeHandlers(
      deps({
        createPr: async () => {
          throw new Error("boom-create");
        },
      }),
    );
    const result = await handlers["pr-create"](NODE, ctx());
    // Failure is a ROUTABLE success-outcome with value:"failed", not a throw.
    expect(result).toEqual({ outcome: "success", value: "failed" });

    // `failed` is terminal, so the entity is no longer "active" — but it exists.
    expect(store.getActivePrEntityBySource("task", "T-1")).toBeNull();
    const failed = store.getPrEntity(seeded.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.failureReason).toContain("boom-create");
    expect(failed?.prNumber).toBeUndefined();
  });

  it("pr-create idempotent re-entry on an already-open entity is a no-op", async () => {
    const createPr = vi.fn(async () => ({ prNumber: 7, prUrl: "u", headOid: "h" }));
    const handlers = createPrNodeHandlers(deps({ createPr }));

    const first = await handlers["pr-create"](NODE, ctx());
    expect(first.value).toBe("open");
    expect(createPr).toHaveBeenCalledTimes(1);

    const second = await handlers["pr-create"](NODE, ctx());
    expect(second).toEqual({ outcome: "success", value: "open" });
    // Re-entry must NOT call GitHub again, and must NOT mint a second entity.
    expect(createPr).toHaveBeenCalledTimes(1);
  });

  it("pr-merge stale head → value:stale-head, entity stays open, no merged write", async () => {
    // Seed an open, verified entity.
    const created = store.ensurePrEntityForSource({ ...SOURCE, state: "open", prNumber: 9 });
    store.updatePrEntity(created.id, { headOid: "stale" });

    const handlers = createPrNodeHandlers(
      deps({ mergePr: async () => ({ status: "stale-head" }) as PrMergeCallResult }),
    );
    const result = await handlers["pr-merge"]({ id: "m", kind: "pr-merge" } as WorkflowIrNode, ctx());
    expect(result).toEqual({ outcome: "success", value: "stale-head" });

    const entity = store.getPrEntity(created.id);
    expect(entity?.state).toBe("open"); // never advanced to merged
  });

  it("pr-merge success emits merged-requested and does NOT write merged (reconcile corroborates)", async () => {
    const created = store.ensurePrEntityForSource({ ...SOURCE, state: "open", prNumber: 9 });
    store.updatePrEntity(created.id, { headOid: "tip" });

    const mergePr = vi.fn(async () => ({ status: "merged-requested" }) as PrMergeCallResult);
    const handlers = createPrNodeHandlers(deps({ mergePr }));
    const result = await handlers["pr-merge"]({ id: "m", kind: "pr-merge" } as WorkflowIrNode, ctx());
    expect(result).toEqual({ outcome: "success", value: "merged-requested" });
    // expectedHeadOid is passed from the entity's headOid.
    expect(mergePr).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: "tip" }));

    const entity = store.getPrEntity(created.id);
    expect(entity?.state).toBe("open"); // node never writes merged
  });

  it("unverified entity is not merged or responded to — emits a benign outcome", async () => {
    const created = store.ensurePrEntityForSource({
      ...SOURCE,
      state: "open",
      prNumber: 9,
      unverified: true,
    });

    const mergePr = vi.fn(async () => ({ status: "merged-requested" }) as PrMergeCallResult);
    const respond = vi.fn(async () => ({ value: "fixed" as const }));
    const handlers = createPrNodeHandlers(deps({ mergePr, respond }));

    const merge = await handlers["pr-merge"]({ id: "m", kind: "pr-merge" } as WorkflowIrNode, ctx());
    expect(merge).toEqual({ outcome: "success", value: "not-actionable" });
    expect(mergePr).not.toHaveBeenCalled();

    const resp = await handlers["pr-respond"]({ id: "r", kind: "pr-respond" } as WorkflowIrNode, ctx());
    expect(resp).toEqual({ outcome: "success", value: "not-actionable" });
    expect(respond).not.toHaveBeenCalled();

    const entity = store.getPrEntity(created.id);
    expect(entity?.state).toBe("open");
  });

  it("pr-respond default (no respond dep) is inert: value:disagreed-only + bumps responseRounds", async () => {
    const created = store.ensurePrEntityForSource({ ...SOURCE, state: "open", prNumber: 9 });
    expect(store.getPrEntity(created.id)?.responseRounds).toBe(0);

    const handlers = createPrNodeHandlers(deps()); // no respond
    const result = await handlers["pr-respond"]({ id: "r", kind: "pr-respond" } as WorkflowIrNode, ctx());
    expect(result).toEqual({ outcome: "success", value: "disagreed-only" });

    expect(store.getPrEntity(created.id)?.responseRounds).toBe(1);
  });

  it("pr-respond delegates to the injected respond callback with the POST-increment entity", async () => {
    const created = store.ensurePrEntityForSource({ ...SOURCE, state: "open", prNumber: 9 });
    store.updatePrEntity(created.id, { responseRounds: 3 });
    let forwardedRounds: number | undefined;
    const respond: PrNodeDeps["respond"] = async (input) => {
      forwardedRounds = input.entity.responseRounds;
      return { value: "fixed" as const, contextPatch: { k: "v" } };
    };
    const handlers = createPrNodeHandlers(deps({ respond }));

    const result = await handlers["pr-respond"]({ id: "r", kind: "pr-respond" } as WorkflowIrNode, ctx());
    expect(result).toEqual({ outcome: "success", value: "fixed", contextPatch: { k: "v" } });
    // The handler must forward the entity returned by updatePrEntity (post-increment),
    // not the stale pre-increment copy — otherwise the R8 cap check fires one round late.
    expect(forwardedRounds).toBe(4);
  });

  it("pr-merge / pr-respond resolve a branch-group entity via branchContext.groupId, not task id", async () => {
    // Branch-group PR entities are keyed by the GROUP id (sourceId = branch_groups.id).
    // A shared-mode task carries that id on branchContext.groupId, NOT task.id.
    const groupId = "BG-1";
    store.ensurePrEntityForSource({
      sourceType: "branch-group",
      sourceId: groupId,
      repo: "owner/repo",
      headBranch: "fusion/bg-1",
      state: "open",
      prNumber: 11,
    });
    const groupCtx = {
      task: { id: "T-shared", branchContext: { groupId } } as unknown as TaskDetail,
      settings: undefined,
      context: {},
    } as WorkflowNodeExecutionContext;

    const mergePr = vi.fn(async () => ({ status: "merged-requested" }) as PrMergeCallResult);
    const handlers = createPrNodeHandlers(deps({ mergePr }));
    const merge = await handlers["pr-merge"]({ id: "m", kind: "pr-merge" } as WorkflowIrNode, groupCtx);
    expect(merge).toEqual({ outcome: "success", value: "merged-requested" });
    expect(mergePr).toHaveBeenCalledTimes(1);
  });

  it("unwired pr-* deps fail closed (value:pr-nodes-unwired)", async () => {
    // createDefaultNodeHandlers with no prNodes dep → the three kinds fail closed.
    const handlers = createDefaultNodeHandlers(createNoopLegacySeams(), undefined, {});
    for (const kind of ["pr-create", "pr-respond", "pr-merge"] as const) {
      const result = await handlers[kind]({ id: kind, kind } as WorkflowIrNode, ctx());
      expect(result).toEqual({ outcome: "failure", value: "pr-nodes-unwired" });
    }
  });

  it("createDefaultNodeHandlers wires real pr-* handlers when prNodes is supplied", async () => {
    const handlers = createDefaultNodeHandlers(createNoopLegacySeams(), undefined, { prNodes: deps() });
    const result = await handlers["pr-create"](NODE, ctx());
    expect(result).toEqual({ outcome: "success", value: "open" });
  });
});

// ── U18 (R15): the autoResolveReviewComments setting gates the loop ────────────
// buildRespondCallback reads settings.autoResolveReviewComments. When false the
// loop is inert: it dispatches no agent, fetches no threads, pushes nothing, and
// replies to no thread — review threads are left for a human. Default (true /
// undefined) preserves today's always-on behavior. This is INDEPENDENT of the
// auto-merge gate (a separate graph node), so disabling auto-merge does not turn
// off resolution and enabling resolution does not force a merge.
describe("Review-response auto-resolution setting gate (U18)", () => {
  let rootDir: string;
  let store: TaskStore;
  let entity: PrEntity;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global"));
    await store.init();
    entity = store.ensurePrEntityForSource({ ...SOURCE, state: "open", prNumber: 9 });
    entity = store.updatePrEntity(entity.id, { headOid: "head-1", unverified: false });
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function respondOps(over: Partial<PrRespondGithubOps> = {}): {
    ops: PrRespondGithubOps;
    calls: { getReviewThreads: number; replies: number; resolves: number };
  } {
    const calls = { getReviewThreads: 0, replies: 0, resolves: 0 };
    const ops: PrRespondGithubOps = {
      // Return NO actionable threads. The enabled-path tests only need to prove the
      // gate let the loop through (getReviewThreads ran); with no actionable thread
      // the run returns early WITHOUT dispatching the mutating agent — which keeps
      // these unit tests off the real-AI-CLI path. A disabled loop never even gets
      // here (it short-circuits before fetching threads).
      getReviewThreads: async () => {
        calls.getReviewThreads += 1;
        return [];
      },
      getViewerLogin: async () => "fusion-bot",
      checkPrStillOpen: async () => ({ open: true, headOid: "head-1" }),
      replyToThread: async () => {
        calls.replies += 1;
      },
      resolveThread: async () => {
        calls.resolves += 1;
      },
      getCwd: () => rootDir,
      getTaskId: () => "T-1",
      ...over,
    };
    return { ops, calls };
  }

  it("disabled → loop is inert: no thread fetch, no reply, returns disagreed-only", async () => {
    await store.updateSettings({ autoResolveReviewComments: false });
    const { ops, calls } = respondOps();
    const audited: string[] = [];
    const respond = buildRespondCallback(() => store, ops, (reason) => audited.push(reason));

    const result = await respond({
      task: { id: "T-1" } as unknown as TaskDetail,
      node: { id: "r", kind: "pr-respond" } as WorkflowIrNode,
      entity,
      context: {},
    });

    expect(result).toEqual({ value: "disagreed-only" });
    // Inert: the loop never even fetched threads, never replied, never resolved.
    expect(calls.getReviewThreads).toBe(0);
    expect(calls.replies).toBe(0);
    expect(calls.resolves).toBe(0);
    expect(audited).toContain("pr-respond-auto-resolve-disabled");
  });

  it("default (setting unset) → loop runs: fetches threads (always-on preserved)", async () => {
    // Do NOT touch the setting; the default is true.
    const { ops, calls } = respondOps();
    const respond = buildRespondCallback(() => store, ops);

    await respond({
      task: { id: "T-1" } as unknown as TaskDetail,
      node: { id: "r", kind: "pr-respond" } as WorkflowIrNode,
      entity,
      context: {},
    });

    // The loop proceeded far enough to fetch review threads — it is NOT inert.
    expect(calls.getReviewThreads).toBe(1);
  });

  it("explicitly enabled → loop runs (independent of auto-merge being off)", async () => {
    await store.updateSettings({ autoResolveReviewComments: true, autoMerge: false });
    const { ops, calls } = respondOps();
    const respond = buildRespondCallback(() => store, ops);

    await respond({
      task: { id: "T-1" } as unknown as TaskDetail,
      node: { id: "r", kind: "pr-respond" } as WorkflowIrNode,
      entity,
      context: {},
    });

    // Resolution ran even though auto-merge is off — the two gates are independent.
    expect(calls.getReviewThreads).toBe(1);
  });
});
