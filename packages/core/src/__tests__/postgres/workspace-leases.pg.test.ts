import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../__test-utils__/pg-test-harness.js";
import type { WorkspaceLeaseOwner } from "../../tasks/workspace-lease-types.js";

const pgTest = pgDescribe;

/*
FNXC:WorkspaceLease 2026-08-15-08:57:
A workspace lease is reentrant only for its complete task/node/incarnation owner
triple. Reentry must renew its TTL without minting a fence token or dropping a
published fence pin; either change lets a live writer lose its git CAS authority.
*/
pgTest("workspace coordination leases (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_workspace_leases" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const owner: WorkspaceLeaseOwner = {
    taskId: "FN-9059-owner",
    nodeId: "node-a",
    incarnationId: "incarnation-a",
  };

  it("conflicts when any owner-triple member differs, but reenters for the exact owner", async () => {
    const first = h.store();
    const second = h.store();
    const leaseKey = "workspace:repo-a:owner-triple";
    const acquired = await first.acquireWorkspaceLease({ leaseKey, kind: "land", owner, leaseMs: 60_000 });
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome === "conflict") throw new Error("expected initial workspace lease claim");

    const changes: Array<Partial<WorkspaceLeaseOwner>> = [
      { taskId: "FN-9059-other" },
      { nodeId: "node-b" },
      { incarnationId: "incarnation-b" },
    ];
    for (const changedOwner of changes) {
      const result = await second.acquireWorkspaceLease({
        leaseKey,
        kind: "land",
        owner: { ...owner, ...changedOwner },
        leaseMs: 60_000,
      });
      expect(result.outcome).toBe("conflict");
      if (result.outcome === "conflict") {
        expect(result.conflict).toMatchObject({
          taskId: owner.taskId,
          nodeId: owner.nodeId,
          incarnationId: owner.incarnationId,
          fenceToken: acquired.handle.fenceToken,
        });
      }
    }

    const reentrant = await second.acquireWorkspaceLease({ leaseKey, kind: "land", owner, leaseMs: 60_000 });
    expect(reentrant.outcome).toBe("reentrant");
    if (reentrant.outcome === "conflict") throw new Error("expected exact owner reentry");
    expect(reentrant.handle.fenceToken).toBe(acquired.handle.fenceToken);
  });

  it("labels a released row as reclaimed and clears its previous fence pin", async () => {
    const store = h.store();
    const leaseKey = "workspace:repo-a:released-reclaim";
    const first = await store.acquireWorkspaceLease({ leaseKey, kind: "land", owner, leaseMs: 60_000 });
    if (first.outcome === "conflict") throw new Error("expected initial claim");
    const pinned = await store.recordWorkspaceLeaseFenceRef({
      handle: first.handle,
      fenceRefName: "refs/fusion/fence/released",
      fenceRefSha: "fence-sha",
    });
    await store.releaseWorkspaceLease(pinned);

    const reclaimed = await store.acquireWorkspaceLease({ leaseKey, kind: "land", owner, leaseMs: 60_000 });
    expect(reclaimed.outcome).toBe("reclaimed-expired");
    if (reclaimed.outcome === "conflict") throw new Error("expected reclaimed lease");
    expect(reclaimed.handle.fenceToken).toBeGreaterThan(pinned.fenceToken);
    expect(reclaimed.handle.fenceRefName).toBeUndefined();
    expect(reclaimed.handle.fenceRefSha).toBeUndefined();
  });

  it("preserves a land fence pin across reentrant renewal", async () => {
    const store = h.store();
    const leaseKey = "workspace:repo-a:fence-pin";
    const acquired = await store.acquireWorkspaceLease({ leaseKey, kind: "land", owner, leaseMs: 60_000 });
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome === "conflict") throw new Error("expected initial workspace lease claim");

    const pinned = await store.recordWorkspaceLeaseFenceRef({
      handle: acquired.handle,
      fenceRefName: "refs/fusion/fence/FN-9059",
      fenceRefSha: "fence-sha",
    });
    const reentrant = await store.acquireWorkspaceLease({ leaseKey, kind: "land", owner, leaseMs: 60_000 });

    expect(reentrant).toMatchObject({
      outcome: "reentrant",
      handle: {
        fenceToken: pinned.fenceToken,
        fenceRefName: pinned.fenceRefName,
        fenceRefSha: pinned.fenceRefSha,
      },
    });
    const [persisted] = await store.inspectWorkspaceLeases({ leaseKeys: [leaseKey] });
    expect(persisted?.fenceRefName).toBe(pinned.fenceRefName);
    expect(persisted?.fenceRefSha).toBe(pinned.fenceRefSha);
  });
});

void describe;
