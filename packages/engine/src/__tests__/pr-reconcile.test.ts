import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { TaskStore } from "@fusion/core";
import type { PrEntity } from "@fusion/core";
import {
  PrReconciler,
  deriveTransitions,
  type PrReconcileFetchResult,
  type PrReconcileGithubOps,
} from "../pr-reconcile.js";

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A fake GitHub ops with scriptable probe + deep-fetch responses, recording calls. */
function makeFakeOps(): {
  ops: PrReconcileGithubOps;
  probeCalls: Array<{ repo: string; prNumber: number; etag?: string }>;
  fetchCalls: Array<{ repo: string; prNumber: number }>;
  setProbe: (changed: boolean, etag?: string) => void;
  setFetch: (result: PrReconcileFetchResult | (() => Promise<PrReconcileFetchResult>)) => void;
  failFetch: (message: string) => void;
} {
  const probeCalls: Array<{ repo: string; prNumber: number; etag?: string }> = [];
  const fetchCalls: Array<{ repo: string; prNumber: number }> = [];
  let probeResult: { changed: boolean; etag?: string } = { changed: true, etag: "etag-1" };
  let fetchImpl: () => Promise<PrReconcileFetchResult> = async () => ({ exists: true, prState: "open" });

  return {
    probeCalls,
    fetchCalls,
    setProbe: (changed, etag) => {
      probeResult = { changed, etag };
    },
    setFetch: (result) => {
      fetchImpl = typeof result === "function" ? result : async () => result;
    },
    failFetch: (message) => {
      fetchImpl = async () => {
        throw new Error(message);
      };
    },
    ops: {
      probe: async (repo, prNumber, etag) => {
        probeCalls.push({ repo, prNumber, etag });
        return probeResult;
      },
      fetchPrState: async (repo, prNumber) => {
        fetchCalls.push({ repo, prNumber });
        return fetchImpl();
      },
    },
  };
}

describe("PrReconciler (U4 — node-agnostic GitHub reconcile)", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;
  let release: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    rootDir = makeTmpDir("kb-engine-pr-reconcile-");
    globalDir = makeTmpDir("kb-engine-pr-reconcile-global-");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    release = vi.fn(async () => ({ released: true }));
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  function seedEntity(overrides: Partial<PrEntity> & { sourceId: string; prNumber?: number }): PrEntity {
    const entity = store.ensurePrEntityForSource({
      sourceType: overrides.sourceType ?? "task",
      sourceId: overrides.sourceId,
      repo: overrides.repo ?? "owner/repo",
      headBranch: overrides.headBranch ?? `fusion/${overrides.sourceId}`,
      state: overrides.state ?? "open",
      prNumber: overrides.prNumber,
      unverified: overrides.unverified ?? false,
    });
    // Apply mirror fields that ensure-create does not take.
    if (
      overrides.reviewDecision !== undefined ||
      overrides.mergeable !== undefined ||
      overrides.prUrl !== undefined ||
      overrides.state !== undefined
    ) {
      return store.updatePrEntity(entity.id, {
        state: overrides.state,
        reviewDecision: overrides.reviewDecision,
        mergeable: overrides.mergeable ?? undefined,
        prUrl: overrides.prUrl ?? undefined,
      });
    }
    return entity;
  }

  function makeReconciler(ops: PrReconcileGithubOps): PrReconciler {
    return new PrReconciler({
      store,
      ops,
      releaseByEvent: release as unknown as (taskId: string, tag: string) => Promise<unknown>,
      // Tiny intervals + a no-op timer keep the loop off the test clock.
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
  }

  it("AE4: PR merged on GitHub → fires github:pr-merged + entity becomes terminal (drops from poll)", async () => {
    seedEntity({ sourceId: "TASK-1", prNumber: 10, state: "open" });
    const fake = makeFakeOps();
    fake.setFetch({ exists: true, prState: "merged", prNumber: 10 });
    const reconciler = makeReconciler(fake.ops);

    const fired = await reconciler.reconcileRepoOnce("owner/repo");

    expect(fired.map((t) => t.event)).toEqual(["merged"]);
    expect(release).toHaveBeenCalledWith("TASK-1", "github:pr-merged");

    const entity = store.getActivePrEntityBySource("task", "TASK-1");
    expect(entity).toBeNull(); // now merged ⇒ not active ⇒ out of the poll set.
    expect(store.listActivePrEntities()).toHaveLength(0);
  });

  it("changes-requested on GitHub → fires github:pr-changes-requested", async () => {
    seedEntity({ sourceId: "TASK-2", prNumber: 11, state: "open", reviewDecision: null });
    const fake = makeFakeOps();
    fake.setFetch({ exists: true, prState: "open", prNumber: 11, reviewDecision: "CHANGES_REQUESTED" });
    const reconciler = makeReconciler(fake.ops);

    const fired = await reconciler.reconcileRepoOnce("owner/repo");

    expect(fired.map((t) => t.event)).toEqual(["changes-requested"]);
    expect(release).toHaveBeenCalledWith("TASK-2", "github:pr-changes-requested");
    expect(store.getActivePrEntityBySource("task", "TASK-2")?.reviewDecision).toBe("CHANGES_REQUESTED");
  });

  it("unverified entity with no real PR → cleared on first poll, NOT advanced on stale state (R19)", async () => {
    const seeded = seedEntity({ sourceId: "TASK-3", prNumber: 999, state: "open", unverified: true });
    const fake = makeFakeOps();
    fake.setFetch({ exists: false }); // no PR behind it.
    const reconciler = makeReconciler(fake.ops);

    const fired = await reconciler.reconcileRepoOnce("owner/repo");

    expect(fired).toHaveLength(0);
    expect(release).not.toHaveBeenCalled(); // never advanced on stale state.
    expect(store.getActivePrEntityBySource("task", "TASK-3")).toBeNull(); // cleared (closed).
    expect(store.getPrEntity(seeded.id)?.state).toBe("closed");
    expect(store.getPrEntity(seeded.id)?.unverified).toBe(false);

    const audit = store.getRunAuditEvents({ agentId: "pr-reconcile" });
    expect(audit.some((e) => e.mutationType === "pr-reconcile:cleared-fiction")).toBe(true);
  });

  it("N entities in one repo → one batched probe PER ENTITY but a single tick (rate-limit batching)", async () => {
    seedEntity({ sourceId: "TASK-A", prNumber: 21, state: "open" });
    seedEntity({ sourceId: "TASK-B", prNumber: 22, state: "open" });
    seedEntity({ sourceId: "TASK-C", prNumber: 23, state: "open" });
    const fake = makeFakeOps();
    fake.setProbe(false); // 304 unchanged for all.
    const reconciler = makeReconciler(fake.ops);

    await reconciler.reconcileRepoOnce("owner/repo");

    // All three probed in the single tick for the one repo; no deep-fetch (304).
    expect(fake.probeCalls).toHaveLength(3);
    expect(fake.fetchCalls).toHaveLength(0);
    // The repo grouping ran once for the whole repo (single tick, not per-entity ticks).
    expect(reconciler.getTrackedRepos()).toEqual(["owner/repo"]);
  });

  it("probe 304 → no deep-fetch, no writes", async () => {
    const seeded = seedEntity({ sourceId: "TASK-4", prNumber: 30, state: "open", reviewDecision: null });
    const beforeUpdatedAt = seeded.updatedAt;
    const fake = makeFakeOps();
    fake.setProbe(false);
    const reconciler = makeReconciler(fake.ops);

    const fired = await reconciler.reconcileRepoOnce("owner/repo");

    expect(fired).toHaveLength(0);
    expect(fake.fetchCalls).toHaveLength(0);
    expect(release).not.toHaveBeenCalled();
    expect(store.getActivePrEntityBySource("task", "TASK-4")?.updatedAt).toBe(beforeUpdatedAt);
  });

  it("deep-fetch error → persisted audit event + poller survives (backoff)", async () => {
    seedEntity({ sourceId: "TASK-5", prNumber: 40, state: "open" });
    const fake = makeFakeOps();
    fake.failFetch("boom: github 500");
    const reconciler = makeReconciler(fake.ops);

    // Must not throw — the loop records the error and continues.
    await expect(reconciler.reconcileRepoOnce("owner/repo")).resolves.toEqual([]);

    const audit = store.getRunAuditEvents({ agentId: "pr-reconcile" });
    const errEvent = audit.find((e) => e.mutationType === "pr-reconcile:error");
    expect(errEvent).toBeTruthy();
    expect(JSON.stringify(errEvent?.metadata)).toContain("boom: github 500");

    // Entity remains active (poller survives, did not corrupt state).
    expect(store.getActivePrEntityBySource("task", "TASK-5")).toBeTruthy();
  });

  it("deriveTransitions: terminal short-circuits, review + conflict are independent", () => {
    const base = {
      id: "x",
      sourceType: "task",
      sourceId: "t",
      repo: "owner/repo",
      headBranch: "h",
      state: "open",
      autoMerge: false,
      unverified: false,
      responseRounds: 0,
      createdAt: 0,
      updatedAt: 0,
    } as PrEntity;

    expect(deriveTransitions(base, { exists: true, prState: "merged" }).map((t) => t.event)).toEqual(["merged"]);
    expect(deriveTransitions(base, { exists: true, prState: "closed" }).map((t) => t.event)).toEqual(["closed"]);

    // Both a review change and a conflict can fire on one pass.
    const both = deriveTransitions(base, {
      exists: true,
      prState: "open",
      reviewDecision: "APPROVED",
      mergeable: "conflicting",
    });
    expect(both.map((t) => t.event).sort()).toEqual(["approved", "conflict"]);

    // conflict-cleared only when transitioning FROM conflicting → clean.
    const cleared = deriveTransitions({ ...base, mergeable: "conflicting" }, {
      exists: true,
      prState: "open",
      mergeable: "clean",
    });
    expect(cleared.map((t) => t.event)).toEqual(["conflict-cleared"]);

    // UNKNOWN mergeable never maps to conflict.
    expect(
      deriveTransitions(base, { exists: true, prState: "open", mergeable: "unknown" }).map((t) => t.event),
    ).toEqual([]);
  });

  it("REGRESSION (R20): scheduler.ts contains zero PR symbols", () => {
    const schedulerPath = fileURLToPath(new URL("../scheduler.ts", import.meta.url));
    const source = readFileSync(schedulerPath, "utf8");
    expect(source).not.toMatch(/pr-create|pr-respond|pull_request|PrEntity|pr-reconcile|PrReconciler/);
  });
});
