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

    const { CentralCore } = await import("@fusion/core");
    const central = new CentralCore();
    await central.init();

    const entries = await central.getRecentActivity({ limit, projectId, types });
    await central.close();

    res.json(entries);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/**
 * GET /api/global-concurrency
 * Get global concurrency state across all projects.
 * Returns: GlobalConcurrencyState
 */
router.get("/global-concurrency", async (_req, res) => {
  try {
    const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
    const shouldClose = !options?.centralCore;
    if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) await central.init();

    const state = await central.getGlobalConcurrencyState();
    const liveCounts = await central.getLiveRunningAgentCounts();

    /*
    FNXC:GlobalConcurrencyControls 2026-06-26-17:22:
    The published global-concurrency route reads currentlyActive/projectsActive through CentralCore's live seam while preserving globalMaxConcurrent/queuedCount from slot bookkeeping. The dashboard-registered source only inspects already-open project stores, so this read stays side-effect-safe and never opens watchers or starts project runtimes.
    */
    const liveState = {
      ...state,
      currentlyActive: liveCounts.currentlyActive,
      projectsActive: liveCounts.projectsActive,
    };

    if (shouldClose) await central.close();

    res.json(liveState);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    rethrowAsApiError(err);
  }
});

/**
 * PUT /api/global-concurrency
 * Update the system-wide concurrency limit across all projects.
 * Body: { globalMaxConcurrent: number }
 * Returns: GlobalConcurrencyState
 */
router.put("/global-concurrency", async (req, res) => {
  const { globalMaxConcurrent } = req.body ?? {};
  if (!Number.isInteger(globalMaxConcurrent) || globalMaxConcurrent < 1 || globalMaxConcurrent > 10000) {
    throw badRequest("globalMaxConcurrent must be an integer between 1 and 10000");
  }

  try {
    const central = options?.centralCore ?? new (await import("@fusion/core")).CentralCore();
    const shouldClose = !options?.centralCore;
    if (shouldClose || (typeof central.isInitialized === "function" && !central.isInitialized())) await central.init();

    const state = await central.updateGlobalConcurrency({ globalMaxConcurrent });
    if (shouldClose) await central.close();

    res.json(state);
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

      console.warn(
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
      console.warn(
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
