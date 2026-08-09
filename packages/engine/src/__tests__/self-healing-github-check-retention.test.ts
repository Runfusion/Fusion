import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listGitHubCheckStatesAsync,
  recordGitHubCheckStateAsync,
} from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";

function createStore(layer: { projectId?: string } | null) {
  return Object.assign(new EventEmitter(), {
    getAsyncLayer: vi.fn(() => layer),
    getSettings: vi.fn().mockResolvedValue({ globalPause: true, enginePaused: true, maintenanceIntervalMs: 0 }),
    listTasks: vi.fn().mockResolvedValue([]),
    walCheckpoint: vi.fn().mockReturnValue({ busy: 0, log: 0, checkpointed: 0 }),
  }) as any;
}

/** Keeps the scheduler test on the registered retention step, not unrelated filesystem or git maintenance. */
function stubUnrelatedBatchOneSteps(manager: SelfHealingManager): void {
  for (const method of [
    "pruneWorktrees",
    "cleanupOrphans",
    "cleanupStaleTempMergeWorktrees",
    "cleanupOrphanedBranches",
    "reconcileStaleSymbolLocks",
    "maintainTaskFts",
    "enforceWorktreeCap",
  ]) {
    vi.spyOn(manager as any, method).mockResolvedValue(0);
  }
}

describe("GitHub check-state maintenance retention", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-09T14:35:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips layer-less and unscoped stores rather than pruning an unscoped partition", async () => {
    const layerless = new SelfHealingManager(createStore(null), { rootDir: "/tmp/test-project" });
    const unscoped = new SelfHealingManager(createStore({ projectId: "" }), { rootDir: "/tmp/test-project" });

    await (layerless as any).pruneGitHubCheckStatesForMaintenance();
    await (unscoped as any).pruneGitHubCheckStatesForMaintenance();
    expect((layerless as any).githubCheckStateRetentionLastPrunedAt).toEqual(new Map());
    expect((unscoped as any).githubCheckStateRetentionLastPrunedAt).toEqual(new Map());
    layerless.stop();
    unscoped.stop();
  });

  it("keeps a failed retention attempt diagnostic-only and continues batch-1 maintenance", async () => {
    const layer = { projectId: "project-a", db: {} };
    const manager = new SelfHealingManager(createStore(layer), { rootDir: "/tmp/test-project" });
    stubUnrelatedBatchOneSteps(manager);
    const cleanupOrphans = vi.spyOn(manager as any, "cleanupOrphans");

    await expect((manager as any).runMaintenance()).resolves.toBeUndefined();
    expect(cleanupOrphans).toHaveBeenCalledOnce();
    expect((manager as any).githubCheckStateRetentionLastPrunedAt).toEqual(new Map());
    manager.stop();
  });
});

pgDescribe("GitHub check-state retention uses the production maintenance scheduler", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_github_check_retention",
    projectId: "project-a",
  });

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-09T14:35:00.000Z"));
    await h.beforeEach();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("prunes expired rows through runMaintenance, gates repeats, and retries after six hours without a delivery", async () => {
    const layer = h.layer();
    const manager = new SelfHealingManager(createStore(layer), { rootDir: "/tmp/test-project" });
    stubUnrelatedBatchOneSteps(manager);
    const input = {
      repo: "owner/repo",
      headSha: "abcdef1",
      checkName: "ci/build",
      state: "success",
      reportedAt: "2026-08-01T00:00:00.000Z",
    };

    // FNXC:PrMergeEventDrivenChecks 2026-08-09-15:59:
    // Exercise the scheduled owner against a real row: retention must delete expired state even
    // when no further webhook delivery arrives, rather than relying on a mocked prune callback.
    await recordGitHubCheckStateAsync(layer, input, "project-a");
    vi.advanceTimersByTime(14 * 86_400_000 + 1);

    await (manager as any).runMaintenance();
    await expect(listGitHubCheckStatesAsync(layer, input, "project-a")).resolves.toEqual([]);

    const firstPrunedAt = (manager as any).githubCheckStateRetentionLastPrunedAt.get("project-a");
    await (manager as any).runMaintenance();
    expect((manager as any).githubCheckStateRetentionLastPrunedAt.get("project-a")).toBe(firstPrunedAt);

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    await (manager as any).runMaintenance();
    expect((manager as any).githubCheckStateRetentionLastPrunedAt.get("project-a")).toBeGreaterThan(firstPrunedAt);
    manager.stop();
  });
});
