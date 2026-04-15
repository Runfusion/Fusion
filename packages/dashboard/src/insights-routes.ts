/**
 * Insights REST API Routes
 *
 * Provides CRUD endpoints for project insights and insight generation runs.
 * Also includes action endpoints for running insight generation and creating tasks from insights.
 *
 * Endpoints:
 * - Insights: GET /, GET /:id, PATCH /:id, DELETE /:id
 * - Runs: GET /runs, POST /runs, GET /runs/:id
 * - Actions: POST /run (trigger manual run), POST /:id/dismiss, POST /:id/create-task
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskStore } from "@fusion/core";
import {
  InsightStore,
  type InsightCategory,
  type InsightStatus,
  type InsightListOptions,
  type InsightRunTrigger,
  type InsightRunCreateInput,
} from "@fusion/core";
import {
  ApiError,
  badRequest,
  notFound,
} from "./api-error.js";

/**
 * Re-throws an error as an ApiError, converting unknown errors to internal errors.
 */
function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error) throw new ApiError(500, error.message);
  throw new ApiError(500, fallbackMessage);
}

/**
 * Extract projectId from query params or body.
 */
function getProjectId(req: Request): string | undefined {
  if (typeof req.query.projectId === "string" && req.query.projectId.trim()) {
    return req.query.projectId;
  }
  if (req.body && typeof req.body === "object" && typeof req.body.projectId === "string" && req.body.projectId.trim()) {
    return req.body.projectId;
  }
  return undefined;
}

// Valid insight categories
const VALID_CATEGORIES: InsightCategory[] = [
  "quality",
  "performance",
  "architecture",
  "security",
  "reliability",
  "ux",
  "testability",
  "documentation",
  "dependency",
  "workflow",
  "other",
];

// Valid insight statuses
const VALID_STATUSES: InsightStatus[] = ["generated", "confirmed", "stale", "dismissed"];

// Valid run triggers
const VALID_TRIGGERS: InsightRunTrigger[] = ["schedule", "manual", "task_completion", "merge_event", "api"];

/**
 * Create the insights router.
 */
export function createInsightsRouter(store: TaskStore): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<TaskStore>();

  /**
   * Middleware to capture the appropriate store for this request.
   * Uses projectId from query/body to get the scoped store if provided,
   * otherwise falls back to the default store.
   */
  router.use((req: Request, res: Response, next: NextFunction) => {
    const projectId = getProjectId(req);
    if (projectId) {
      // Import here to avoid circular dependency issues
      import("./project-store-resolver.js").then(({ getOrCreateProjectStore }) => {
        getOrCreateProjectStore(projectId).then((scopedStore) => {
          requestContext.run(scopedStore, () => {
            next();
          });
        }).catch((err) => {
          rethrowAsApiError(err, "Failed to get project store");
        });
      });
    } else {
      requestContext.run(store, () => {
        next();
      });
    }
  });

  /**
   * Get the InsightStore from the current request context.
   */
  function getInsightStore(): InsightStore {
    const store = requestContext.getStore();
    if (!store) {
      throw new ApiError(500, "Store context not available");
    }
    return store.getInsightStore();
  }

  // ── List Insights ───────────────────────────────────────────────────────

  router.get("/", (req: Request, res: Response) => {
    try {
      const store = getInsightStore();
      const options: InsightListOptions = {};

      if (req.query.category) {
        const category = req.query.category as string;
        if (!VALID_CATEGORIES.includes(category as InsightCategory)) {
          throw badRequest(`Invalid category: ${category}`);
        }
        options.category = category as InsightCategory;
      }

      if (req.query.status) {
        const status = req.query.status as string;
        if (!VALID_STATUSES.includes(status as InsightStatus)) {
          throw badRequest(`Invalid status: ${status}`);
        }
        options.status = status as InsightStatus;
      }

      if (req.query.runId) {
        options.runId = req.query.runId as string;
      }

      if (req.query.limit) {
        const limit = parseInt(req.query.limit as string, 10);
        if (isNaN(limit) || limit < 1) {
          throw badRequest("Invalid limit");
        }
        options.limit = limit;
      }

      if (req.query.offset) {
        const offset = parseInt(req.query.offset as string, 10);
        if (isNaN(offset) || offset < 0) {
          throw badRequest("Invalid offset");
        }
        options.offset = offset;
      }

      const insights = store.listInsights(options);
      const count = store.countInsights(options);
      res.json({ insights, count });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list insights");
    }
  });

  // ── Get Insight ────────────────────────────────────────────────────────

  router.get("/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const insight = store.getInsight(id);
      if (!insight) {
        throw notFound(`Insight not found: ${id}`);
      }
      res.json(insight);
    } catch (error) {
      rethrowAsApiError(error, "Failed to get insight");
    }
  });

  // ── Update Insight ──────────────────────────────────────────────────────

  router.patch("/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const input: Record<string, unknown> = {};

      if (req.body.title !== undefined) {
        input.title = req.body.title;
      }
      if (req.body.content !== undefined) {
        input.content = req.body.content;
      }
      if (req.body.category !== undefined) {
        if (!VALID_CATEGORIES.includes(req.body.category)) {
          throw badRequest(`Invalid category: ${req.body.category}`);
        }
        input.category = req.body.category;
      }
      if (req.body.status !== undefined) {
        if (!VALID_STATUSES.includes(req.body.status)) {
          throw badRequest(`Invalid status: ${req.body.status}`);
        }
        input.status = req.body.status;
      }

      const insight = store.updateInsight(id, input as Parameters<typeof store.updateInsight>[1]);
      if (!insight) {
        throw notFound(`Insight not found: ${id}`);
      }
      res.json(insight);
    } catch (error) {
      rethrowAsApiError(error, "Failed to update insight");
    }
  });

  // ── Delete Insight ──────────────────────────────────────────────────────

  router.delete("/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const deleted = store.deleteInsight(id);
      if (!deleted) {
        throw notFound(`Insight not found: ${id}`);
      }
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to delete insight");
    }
  });

  // ── Dismiss Insight ────────────────────────────────────────────────────

  router.post("/:id/dismiss", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const insight = store.updateInsight(id, { status: "dismissed" });
      if (!insight) {
        throw notFound(`Insight not found: ${id}`);
      }
      res.json(insight);
    } catch (error) {
      rethrowAsApiError(error, "Failed to dismiss insight");
    }
  });

  // ── Trigger Insight Run ────────────────────────────────────────────────

  router.post("/run", (req: Request, res: Response) => {
    try {
      const projectId = getProjectId(req) ?? "";
      const store = getInsightStore();
      const trigger: InsightRunTrigger = (req.body.trigger as InsightRunTrigger) ?? "manual";

      if (!VALID_TRIGGERS.includes(trigger)) {
        throw badRequest(`Invalid trigger: ${trigger}`);
      }

      const input: InsightRunCreateInput = {
        trigger,
        inputMetadata: req.body.inputMetadata,
      };

      const run = store.createRun(projectId, input);
      res.status(201).json(run);
    } catch (error) {
      rethrowAsApiError(error, "Failed to create insight run");
    }
  });

  // ── List Runs ──────────────────────────────────────────────────────────

  router.get("/runs", (req: Request, res: Response) => {
    try {
      const store = getInsightStore();
      const runs = store.listRuns({});
      res.json({ runs });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list runs");
    }
  });

  // ── Get Run ────────────────────────────────────────────────────────────

  router.get("/runs/:id", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const run = store.getRun(id);
      if (!run) {
        throw notFound(`Run not found: ${id}`);
      }
      res.json(run);
    } catch (error) {
      rethrowAsApiError(error, "Failed to get run");
    }
  });

  // ── Create Task from Insight ────────────────────────────────────────────

  router.post("/:id/create-task", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const insight = store.getInsight(id);
      if (!insight) {
        throw notFound(`Insight not found: ${id}`);
      }

      // The actual task creation would be handled by the frontend
      // This endpoint returns the insight data needed to create the task
      res.json({
        success: true,
        insight,
        suggestedTitle: insight.title,
        suggestedDescription: insight.content ?? "",
      });
    } catch (error) {
      rethrowAsApiError(error, "Failed to create task from insight");
    }
  });

  return router;
}
