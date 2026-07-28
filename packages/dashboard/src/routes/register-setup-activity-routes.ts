import { createLogger } from "@fusion/core";

const severityAuditLog = createLogger("dashboard-register-setup-activity-routes");
import type { ActivityEventType } from "@fusion/core";
import { ApiError, badRequest, rethrowAsApiError } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";

export const registerActivityLogRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getProjectContext } = ctx;
// ── Activity Log Routes ─────────────────────────────────────────────

/**
 * GET /api/activity
 * Get activity log entries.
 * Query params: limit (default 100, max 1000), since (ISO timestamp), type (event type filter)
 * Returns: ActivityLogEntry[] sorted newest first
 */
router.get("/activity", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    const limitParam = req.query.limit;
    const sinceParam = req.query.since;
    const typeParam = req.query.type;

    // Parse and validate limit. Omitted limit intentionally defaults to 100
    // to match the documented API contract and avoid unbounded history reads.
    let limit = 100;
    if (limitParam !== undefined) {
      const parsed = Number.parseInt(limitParam as string, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw badRequest("limit must be a non-negative integer");
      }
      limit = Math.min(parsed, 1000); // Max 1000
    }

    // Validate type if provided
    const validTypes = ["task:created", "task:moved", "task:updated", "task:deleted", "task:merged", "task:failed", "settings:updated"];
    if (typeParam !== undefined && !validTypes.includes(typeParam as string)) {
      throw badRequest(`Invalid type. Must be one of: ${validTypes.join(", ")}`);
    }

    const options: { limit?: number; since?: string; type?: ActivityEventType } = {
      limit,
      since: sinceParam as string | undefined,
      type: typeParam as ActivityEventType | undefined,
    };

    const entries = await scopedStore.getActivityLog(options);
    res.json(entries);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/**
 * DELETE /api/activity
 * Clear all activity log entries (maintenance endpoint).
 * Returns: { success: true }
 */
router.delete("/activity", async (req, res) => {
  try {
    const { store: scopedStore } = await getProjectContext(req);
    await scopedStore.clearActivityLog();
    res.json({ success: true });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

};

export const registerSetupActivityRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options } = ctx;
/**
 * GET /api/activity-feed
 * Get unified activity feed across all projects.
 * Query: limit, projectId, types
 * Returns: ActivityFeedEntry[]
 */
router.get("/activity-feed", async (req, res) => {
  try {
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const typesParam = typeof req.query.types === "string" ? req.query.types.split(",") : undefined;
    const types = typesParam as import("@fusion/core").ActivityEventType[] | undefined;

    /*
    FNXC:ActivityFeed 2026-07-28-03:00:
    Prefer the server-owned centralCore (already backend-mode with asyncLayer) over `new CentralCore()` so GET /api/activity-feed does not open a per-request pool and cannot hit backendHandle-before-attach. Mirrors global-concurrency / setup-state routes. Layer-less fallback still works once CentralCore.init restores PG bootstrap (#2454 regression).
    */
    const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
    const shouldClose = !options?.centralCore;
    if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) {
      await central.init();
    }

    const entries = await central.getRecentActivity({ limit, projectId, types });
    if (shouldClose) await central.close();

    res.json(entries);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/*
FNXC:CapacityModel 2026-07-28-23:45 (drop the cross-project cap — settings half):
PUT /api/global-concurrency is DELETED: it set a machine-wide limit that no longer
exists. Capacity is two numbers PER PROJECT.

GET SURVIVES but returns TELEMETRY ONLY — live "N running" counts per project, via
CentralCore's registered side-effect-safe source. It no longer reports
globalMaxConcurrent or queuedCount: those came from the deleted cap and from slot
bookkeeping that production code never incremented, so publishing them was
publishing zeros dressed as state. Nothing gates on this route.
*/
router.get("/global-concurrency", async (_req, res) => {
  try {
    const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
    const shouldClose = !options?.centralCore;
    if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) await central.init();

    const liveCounts = await central.getLiveRunningAgentCounts();

    if (shouldClose) await central.close();

    res.json({
      currentlyActive: liveCounts.currentlyActive,
      projectsActive: liveCounts.projectsActive,
    });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/**
 * GET /api/first-run-status
 * Check if user has projects or needs setup wizard.
 * Returns: { hasProjects: boolean, singleProjectPath: string | null }
 */
router.get("/first-run-status", async (_req, res) => {
  try {
    const { CentralCore, FirstRunDetector } = await import("@fusion/core");
    const central = options?.centralCore ?? new CentralCore();
    const shouldClose = !options?.centralCore;
    const detector = new FirstRunDetector(central.getGlobalDir());

    try {
      if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) {
        await central.init();
      }

      const projects = await central.listProjects();
      const hasProjects = projects.length > 0;
      const singleProjectPath = projects.length === 1 ? projects[0].path : null;

      res.json({ hasProjects, singleProjectPath });
    } catch (error) {
      const detectedProjects = await detector.detectExistingProjects(process.cwd());
      const hasProjects = detectedProjects.length > 0;
      const singleProjectPath = detectedProjects.length === 1 ? detectedProjects[0].path : null;

      severityAuditLog.warn(
        `[routes:first-run-status] Falling back to detected projects after central DB error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      res.json({ hasProjects, singleProjectPath });
    } finally {
      if (shouldClose) {
        await central.close();
      }
    }

  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/**
 * GET /api/setup-state
 * Returns the first-run state and any detected projects for migration.
 * This is used by the dashboard to determine what UI to show on startup.
 */
router.get("/setup-state", async (_req, res) => {
  try {
    const { CentralCore, FirstRunDetector } = await import("@fusion/core");
    const central = options?.centralCore ?? new CentralCore();
    const shouldClose = !options?.centralCore;
    const detector = new FirstRunDetector(central.getGlobalDir());
    const detectedProjects = await detector.detectExistingProjects(process.cwd());
    let state: "fresh-install" | "setup-wizard" | "normal-operation" = detectedProjects.length > 0
      ? "setup-wizard"
      : "fresh-install";
    let projects: Array<{ id: string; name: string; path: string }> = [];
    let centralBackendAvailable = false;

    try {
      if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) {
        await central.init();
      }
      centralBackendAvailable = true;
      state = await detector.detectFirstRunState(central);
      projects = await central.listProjects();
    } catch (error) {
      severityAuditLog.warn(
        `[routes:setup-state] Unable to read central DB state: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (shouldClose) {
        await central.close();
      }
    }

    res.json({
      state,
      detectedProjects,
      // FNXC:PostgresProjectDiscovery 2026-07-14-17:30: Report PostgreSQL
      // central-registry availability, never legacy fusion-central.db presence.
      hasCentralDb: centralBackendAvailable,
      registeredProjects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
      })),
    });
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/**
 * POST /api/complete-setup
 * Complete the first-run setup by registering projects.
 * Body: { projects: Array<{ path: string, name: string, isolationMode?: "in-process" | "child-process" }> }
 */
router.post("/complete-setup", async (req, res) => {
  try {
    const { CentralCore } = await import("@fusion/core");
    const { MigrationCoordinator } = await import("@fusion/core");

    const { projects } = req.body as {
      projects: Array<{ path: string; name: string; isolationMode?: "in-process" | "child-process" }>;
    };

    if (!Array.isArray(projects)) {
      throw badRequest("projects must be an array");
    }

    const central = options?.centralCore ?? new CentralCore();
    const shouldClose = !options?.centralCore;

    if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) {
      await central.init();
    }

    try {
      const coordinator = new MigrationCoordinator(central);
      const result = await coordinator.completeSetup(projects);

      res.json({
        success: result.success,
        projectsRegistered: result.projectsRegistered,
        errors: result.errors,
      });
    } finally {
      if (shouldClose) {
        await central.close();
      }
    }
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

};
