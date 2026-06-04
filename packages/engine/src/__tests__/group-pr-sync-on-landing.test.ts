import { describe, expect, it, vi } from "vitest";

import type { BranchGroup, Task } from "@fusion/core";
import { syncGroupPrOnLanding } from "../merger.js";
import type { SyncGroupPrFn } from "../group-merge-coordinator.js";

/**
 * ## Surface Enumeration
 *
 * Narrow-seam coverage (FN-5048) for the U6 sync-on-landing write guard,
 * extracted from the merger's fire-and-forget background block:
 * - no persisted open PR → the sync callback is never invoked
 * - matching snapshot + out-of-band terminal state → reconciliation persisted
 * - stale snapshot (a newer PR stored mid-sync) → the stale write is skipped
 * The full landing pipeline (real git, aiMergeTask) is covered by the
 * reliability suite `branch-group-pr-sync.test.ts`; this file pins the race
 * deterministically without expanding that slow suite.
 */
function makeGroup(partial: Partial<BranchGroup>): BranchGroup {
  return {
    id: "BG-1",
    sourceType: "planning",
    sourceId: "PS-1",
    branchName: "fusion/groups/g1",
    autoMerge: true,
    prState: "open",
    prNumber: 13,
    prUrl: "https://github.com/o/r/pull/13",
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  } as BranchGroup;
}

function makeStore(initial: BranchGroup) {
  let group: BranchGroup = initial;
  return {
    getBranchGroup: vi.fn(() => group),
    listTasksByBranchGroup: vi.fn(async () => [] as Task[]),
    updateBranchGroup: vi.fn((_id: string, patch: Partial<BranchGroup>) => {
      group = { ...group, ...patch } as BranchGroup;
      return group;
    }),
    // test hook to simulate a concurrent landing/promotion swapping the PR
    _swap(patch: Partial<BranchGroup>) {
      group = { ...group, ...patch } as BranchGroup;
    },
    _current() {
      return group;
    },
  };
}

describe("syncGroupPrOnLanding (U6 stale-snapshot write guard)", () => {
  it("does not invoke the callback when the group has no persisted open PR", async () => {
    const store = makeStore(makeGroup({ prState: "none", prNumber: undefined }));
    const syncGroupPr = vi.fn() as unknown as SyncGroupPrFn;
    await syncGroupPrOnLanding({ store, groupId: "BG-1", cwd: "/tmp/project", syncGroupPr });
    expect(syncGroupPr).not.toHaveBeenCalled();
  });

  it("persists out-of-band terminal reconciliation when the snapshot still matches", async () => {
    const store = makeStore(makeGroup({}));
    const syncGroupPr: SyncGroupPrFn = vi.fn(async ({ group }) => ({
      prNumber: group.prNumber!,
      prUrl: group.prUrl!,
      prState: "merged" as const,
    }));
    await syncGroupPrOnLanding({ store, groupId: "BG-1", cwd: "/tmp/project", syncGroupPr });
    expect(store.updateBranchGroup).toHaveBeenCalledTimes(1);
    expect(store._current().prState).toBe("merged");
    expect(store._current().prNumber).toBe(13);
  });

  it("skips the stale write when a newer PR was stored between sync and write", async () => {
    const store = makeStore(makeGroup({}));
    // GitHub reports PR #13 merged out-of-band; but while the sync awaits, a
    // newer landing/promotion replaces it with a newer OPEN PR #88. The stale
    // "merged" write must be skipped so #88 survives.
    const syncGroupPr: SyncGroupPrFn = vi.fn(async ({ group }) => {
      store._swap({ prState: "open", prNumber: 88, prUrl: "https://github.com/o/r/pull/88" });
      return { prNumber: group.prNumber!, prUrl: group.prUrl!, prState: "merged" as const };
    });
    await syncGroupPrOnLanding({ store, groupId: "BG-1", cwd: "/tmp/project", syncGroupPr });
    expect(store.updateBranchGroup).not.toHaveBeenCalled();
    expect(store._current().prNumber).toBe(88);
    expect(store._current().prState).toBe("open");
  });
});
