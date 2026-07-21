import type { Request } from "express";
import { findVitestProcessIds, getAvailableMemoryBytes } from "@fusion/core";
import { ApiError, notFound, rethrowAsApiError } from "../api-error.js";
import { fetchFromRemoteNode } from "./register-settings-sync-helpers.js";
import type { ApiRouteRegistrar } from "./types.js";
import os from "node:os";
import v8 from "node:v8";

/**
 * FNXC:RouteModularity 2026-07-19-18:00:
 * System maintenance routes moved with their process-local CPU sampling helpers so
 * stats remain accurate while the registrar stays before model/auth routes.
 */
export const registerSystemMaintenanceRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getProjectContext } = ctx;
let lastCpuUsageSample: NodeJS.CpuUsage | null = null;
let lastCpuSampleAt: number | null = null;

const getAppCpuPercent = (): number | null => {
  const currentCpuUsage = process.cpuUsage();
  const currentSampleAt = Date.now();

  if (lastCpuUsageSample === null || lastCpuSampleAt === null) {
    lastCpuUsageSample = { user: currentCpuUsage.user, system: currentCpuUsage.system };
    lastCpuSampleAt = currentSampleAt;
    return null;
  }

  const elapsedMs = currentSampleAt - lastCpuSampleAt;
  const cpuUsageDelta = process.cpuUsage(lastCpuUsageSample);

  lastCpuUsageSample = { user: currentCpuUsage.user, system: currentCpuUsage.system };
  lastCpuSampleAt = currentSampleAt;

  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }

  const elapsedMicros = elapsedMs * 1_000;
  const usedMicros = cpuUsageDelta.user + cpuUsageDelta.system;
  if (!Number.isFinite(usedMicros) || usedMicros < 0) {
    return null;
  }

  return Math.max(0, Number(((usedMicros / elapsedMicros) * 100).toFixed(1)));
};

const getVitestProcessIds = async (): Promise<number[]> => {
  // Async pgrep/ps via findVitestProcessIds so the dashboard's event loop
  // stays responsive while the process table is walked. The helper filters
  // matches to actual node processes — a bare `pgrep -f vitest` also matches
  // wrapper shells, monitors, and editors whose command line merely mentions
  // vitest, and SIGKILLing those took out unrelated process trees
  // (2026-06-03 incident).
  return findVitestProcessIds();
};

const collectSystemStatsResponse = async (req: Request) => {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const load = os.loadavg();
  const vitestProcessIds = await getVitestProcessIds();
  const cpuPercent = getAppCpuPercent();

  let totalTasks = 0;
  let activeTasks = 0;
  const byColumn: Record<string, number> = {
    triage: 0,
    todo: 0,
    "in-progress": 0,
    "in-review": 0,
    done: 0,
    archived: 0,
  };
  const agentCounts = { idle: 0, active: 0, running: 0, error: 0 };
  let vitestLastAutoKillAt: string | null = null;

  try {
    const { store: scopedStore } = await getProjectContext(req);

    const globalSettingsStore = scopedStore.getGlobalSettingsStore?.();
    if (globalSettingsStore?.getSettings) {
      const globalSettings = await globalSettingsStore.getSettings();
      const candidate = (globalSettings as Record<string, unknown>).vitestLastAutoKillAt;
      if (typeof candidate === "string" && candidate.length > 0) {
        vitestLastAutoKillAt = candidate;
      }
    }

    const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
    totalTasks = tasks.length;

    for (const task of tasks) {
      byColumn[task.column] = (byColumn[task.column] ?? 0) + 1;
      if (task.column === "in-progress" || task.column === "in-review") {
        activeTasks += 1;
      }
    }

    const { AgentStore } = await import("@fusion/core");
    const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir(), asyncLayer: scopedStore.getAsyncLayer() ?? undefined });
    await agentStore.init();
    const agents = await agentStore.listAgents();
    for (const agent of agents) {
      const state = agent.state as keyof typeof agentCounts;
      if (state in agentCounts) {
        agentCounts[state] += 1;
      }
    }
  } catch {
    // System stats should still be available even when project resolution/scoped store fails.
  }

  return {
    systemStats: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapLimit: heapStats.heap_size_limit,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      cpuPercent,
      loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      cpuCount: os.cpus().length,
      systemTotalMem: os.totalmem(),
      /*
      FNXC:CommandCenter 2026-06-21-13:01:
      The public `systemFreeMem` field carries OS-available memory so SystemStatsArea derives Memory Used from reclaimable-aware bytes and matches Activity Monitor on macOS.
      */
      systemFreeMem: getAvailableMemoryBytes(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
    },
    taskStats: {
      total: totalTasks,
      byColumn,
      active: activeTasks,
      agents: agentCounts,
    },
    vitestProcessCount: vitestProcessIds.length,
    vitestLastAutoKillAt,
  };
};

/**
 * GET /api/system-stats
 * Returns process/system metrics plus task and agent aggregates.
 */
router.get("/system-stats", async (req, res) => {
  try {
    res.json(await collectSystemStatsResponse(req));
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/*
FNXC:CommandCenter 2026-07-19-18:00:
The Command Center System area views per-node stats by defaulting to this local process and proxying remote selections to the node's authenticated /api/system-stats endpoint. The shared CPU/vitest helpers now live in this early registrar so the historical route precedence is retained without keeping the route inline in routes.ts.
*/
router.get("/nodes/:id/system-stats", async (req, res) => {
  try {
    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore();
    let node: Awaited<ReturnType<typeof central.getNode>>;
    await central.init();
    try {
      node = await central.getNode(req.params.id);
    } finally {
      await central.close();
    }

    if (!node) {
      throw notFound("Node not found");
    }

    if (node.type === "local") {
      res.json(await collectSystemStatsResponse(req));
      return;
    }

    res.json(await fetchFromRemoteNode(node, "/api/system-stats"));
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/**
 * POST /api/kill-vitest
 * Kill all running vitest processes (excluding this process).
 */
router.post("/kill-vitest", async (_req, res) => {
  try {
    const vitestProcessIds = await getVitestProcessIds();
    const killedPids: number[] = [];

    for (const pid of vitestProcessIds) {
      try {
        process.kill(pid, "SIGKILL");
        killedPids.push(pid);
      } catch {
        // Process may have exited before kill.
      }
    }

    res.json({
      killed: killedPids.length,
      pids: killedPids,
    });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to kill vitest processes");
  }
});

// ── Maintenance Routes ─────────────────────────────────────────────

/**
 * GET /api/maintenance/legacy-automerge-stamps
 * Dry-run the legacy auto-merge stamp cleanup and list candidates.
 */
router.get("/maintenance/legacy-automerge-stamps", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const candidates = await scopedStore.reconcileLegacyAutoMergeStamps();
    res.json({ candidates, count: candidates.length });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to list legacy auto-merge stamps");
  }
});

/**
 * POST /api/maintenance/legacy-automerge-stamps/apply
 * Apply the legacy auto-merge stamp cleanup via the store-owned reconcile API.
 */
router.post("/maintenance/legacy-automerge-stamps/apply", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const cleared = await scopedStore.reconcileLegacyAutoMergeStamps({ apply: true });
    res.json({ cleared, count: cleared.length });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to apply legacy auto-merge stamp cleanup");
  }
});

// ── Backup Routes ─────────────────────────────────────────────────

/**
 * GET /api/backups
 * List all database backups with metadata.
 */
router.get("/backups", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const { createBackupManager, resolveGlobalBackupRoot } = await import("@fusion/core");
    const settings = await scopedStore.getSettings();
    const manager = createBackupManager(resolveGlobalBackupRoot(scopedStore), settings);
    const backups = await manager.listBackups();

    // Calculate total size
    const totalSize = backups.reduce((sum, b) => sum + b.size, 0);

    res.json({
      backups,
      count: backups.length,
      totalSize,
    });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to list backups");
  }
});

/**
 * POST /api/backups
 * Create a new database backup immediately.
 */
router.post("/backups", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const { runBackupCommand, resolveGlobalBackupRoot } = await import("@fusion/core");
    const settings = await scopedStore.getSettings();
    const result = await runBackupCommand(resolveGlobalBackupRoot(scopedStore), settings);

    if (result.success) {
      res.json({
        success: true,
        backupPath: result.backupPath,
        output: result.output,
        deletedCount: result.deletedCount,
      });
    } else {
      throw new ApiError(500, result.output);
    }
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err, "Failed to create backup");
  }
});

};
