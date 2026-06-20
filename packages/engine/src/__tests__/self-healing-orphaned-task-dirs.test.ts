import { describe, expect, it, vi } from "vitest";

import { SelfHealingManager } from "../self-healing.js";

describe("SelfHealingManager orphaned task-dir maintenance", () => {
  it("runs orphaned task-dir reconcile in pause-safe housekeeping", async () => {
    const reconcileOrphanedTaskDirs = vi.fn(async () => ({
      recovered: ["FN-9201"],
      skipped: [],
    }));
    const store = {
      getSettings: vi.fn(async () => ({
        maintenanceIntervalMs: 0,
        globalPause: true,
        enginePaused: false,
        chatAutoCleanupDays: 0,
        mailAutoCleanupDays: 0,
        operationalLogRetentionDays: 0,
        agentLogFileRetentionDays: 0,
      })),
      reconcileOrphanedTaskDirs,
      pruneOperationalLogs: vi.fn(() => ({ deletedTotal: 0, deletedByTable: {} })),
      pruneAgentLogFiles: vi.fn(() => ({ prunedFiles: 0, prunedEntries: 0, freedBytes: 0 })),
    } as any;

    const manager = new SelfHealingManager(store, { rootDir: "/tmp/fusion-self-healing-orphaned-task-dirs-test" });
    vi.spyOn(manager as any, "pruneWorktrees").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "cleanupOrphans").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "cleanupStaleTempMergeWorktrees").mockResolvedValue(0);
    vi.spyOn(manager as any, "cleanupOrphanedBranches").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "maintainTaskFts").mockResolvedValue(undefined);
    vi.spyOn(manager as any, "checkpointWal").mockReturnValue(undefined);
    vi.spyOn(manager as any, "enforceWorktreeCap").mockResolvedValue(undefined);
    vi.spyOn(manager, "archiveStaleDoneTasks").mockResolvedValue(0);

    await (manager as any).runMaintenance();

    expect(reconcileOrphanedTaskDirs).toHaveBeenCalledTimes(1);
  });
});
