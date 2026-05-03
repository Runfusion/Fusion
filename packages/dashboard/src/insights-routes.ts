/**
 * Insights REST API Routes
 *
 * Provides CRUD endpoints for project insights and insight generation runs.
 * Also includes action endpoints for running insight generation and preparing task payload drafts from insights.
 *
 * Endpoints:
 * - Insights: GET /, GET /:id, PATCH /:id, DELETE /:id
 * - Runs: GET /runs, POST /runs, GET /runs/:id
 * - Actions: POST /run (trigger manual run), POST /:id/dismiss, POST /:id/create-task (returns suggested task title/description draft)
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskStore } from "@fusion/core";
import {
  InsightLifecycleError,
  InsightStore,
  executeInsightRunLifecycle,
  retryInsightRunLifecycle,
  type InsightCategory,
  type MemoryInsightCategory,
  type InsightStatus,
  type InsightListOptions,
  type InsightRunTrigger,
  type InsightRunListOptions,
  type InsightRunStatus,
} from "@fusion/core";
import {
  ApiError,
  badRequest,
  notFound,
} from "./api-error.js";
import { createFnAgent, promptWithFallback } from "@fusion/engine";

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

const INSIGHT_CATEGORY_BY_MEMORY_CATEGORY: Record<MemoryInsightCategory, InsightCategory> = {
  pattern: "workflow",
  principle: "architecture",
  convention: "workflow",
  pitfall: "quality",
  context: "other",
};

const activeRunControllers = new Map<string, AbortController>();

async function withAbort<T>(signal: AbortSignal, task: Promise<T>): Promise<T> {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function executeInsightAttempt(params: {
  rootDir: string;
  projectId: string;
  runId: string;
  signal: AbortSignal;
  insightStore: InsightStore;
}): Promise<{ summary: string; insightsCreated: number; insightsUpdated: number }> {
  const {
    readWorkingMemory,
    readInsightsMemory,
    writeInsightsMemory,
    buildInsightExtractionPrompt,
    parseInsightExtractionResponse,
    mergeInsights,
    computeInsightFingerprint,
  } = await import("@fusion/core");

  const workingMemory = await readWorkingMemory(params.rootDir);
  if (!workingMemory.trim()) {
    throw new Error("No working memory to analyze");
  }

  const existingInsights = await readInsightsMemory(params.rootDir);
  let responseText = "";
  const { session } = await createFnAgent({
    cwd: params.rootDir,
    systemPrompt: [
      "You extract durable project insights from working memory notes.",
      "Return only valid JSON that matches the requested schema.",
      "Do not execute tools or make code changes.",
    ].join("\n"),
    tools: "readonly",
    onText: (delta: string) => {
      responseText += delta;
    },
  });

  try {
    const prompt = buildInsightExtractionPrompt(workingMemory, existingInsights);
    await withAbort(params.signal, promptWithFallback(session, prompt));
  } finally {
    try {
      session.dispose();
    } catch {
      // Best-effort disposal
    }
  }

  const parsedResult = parseInsightExtractionResponse(responseText);
  const mergedInsightsContent = mergeInsights(existingInsights ?? "", parsedResult.insights);
  await writeInsightsMemory(params.rootDir, mergedInsightsContent);

  let insightsCreated = 0;
  let insightsUpdated = 0;

  for (const insight of parsedResult.insights) {
    const category = INSIGHT_CATEGORY_BY_MEMORY_CATEGORY[insight.category] ?? "other";
    const title = toInsightTitle(insight.content);
    const fingerprint = computeInsightFingerprint(title, category);

    const upsertedInsight = params.insightStore.upsertInsight(params.projectId, {
      title,
      content: insight.content,
      category,
      fingerprint,
      provenance: {
        trigger: "manual",
        description: "Manual insight generation",
        metadata: {
          runId: params.runId,
          extractedAt: insight.extractedAt,
        },
      },
    });

    if (upsertedInsight.createdAt === upsertedInsight.updatedAt) {
      insightsCreated += 1;
    } else {
      insightsUpdated += 1;
    }
  }

  return {
    summary: parsedResult.summary,
    insightsCreated,
    insightsUpdated,
  };
}

function toInsightTitle(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "Untitled insight";
  }

  if (trimmed.length <= 100) {
    return trimmed;
  }

  return `${trimmed.slice(0, 100).trimEnd()}...`;
}

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

  // ── Trigger Insight Run ───────────────────────────────────────────────

  router.post("/run", async (req: Request, res: Response) => {
    try {
      const projectId = getProjectId(req) ?? "";
      const insightStore = getInsightStore();
      const trigger: InsightRunTrigger = (req.body.trigger as InsightRunTrigger) ?? "manual";

      if (!VALID_TRIGGERS.includes(trigger)) {
        throw badRequest(`Invalid trigger: ${trigger}`);
      }

      const taskStore = requestContext.getStore();
      if (!taskStore) throw new ApiError(500, "Store context not available");
      const rootDir = taskStore.getRootDir();
      const controller = new AbortController();

      const run = await executeInsightRunLifecycle({
        store: insightStore,
        projectId,
        input: {
          trigger,
          inputMetadata: req.body.inputMetadata,
        },
        signal: controller.signal,
        timeoutMs: typeof req.body.timeoutMs === "number" ? req.body.timeoutMs : 120_000,
        maxAttempts: 2,
        retryDelayMs: 250,
        executeAttempt: async ({ run, signal }) => {
          activeRunControllers.set(run.id, controller);
          return executeInsightAttempt({
            rootDir,
            projectId,
            runId: run.id,
            signal,
            insightStore,
          });
        },
      });

      activeRunControllers.delete(run.id);
      res.status(201).json(run);
    } catch (error) {
      if (error instanceof InsightLifecycleError && error.code === "active_run_conflict") {
        throw new ApiError(409, error.message);
      }
      rethrowAsApiError(error, "Failed to create insight run");
    }
  });

  // ── List Runs ──────────────────────────────────────────────────────────

  router.get("/runs", (req: Request, res: Response) => {
    try {
      const store = getInsightStore();
      const options: InsightRunListOptions = {};

      if (req.query.status) {
        const status = req.query.status as string;
        if (!["pending", "running", "completed", "failed", "cancelled"].includes(status)) {
          throw badRequest(`Invalid run status: ${status}`);
        }
        options.status = status as InsightRunStatus;
      }

      if (req.query.trigger) {
        const trigger = req.query.trigger as string;
        if (!VALID_TRIGGERS.includes(trigger as InsightRunTrigger)) {
          throw badRequest(`Invalid trigger: ${trigger}`);
        }
        options.trigger = trigger as InsightRunTrigger;
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

      const runs = store.listRuns(options);
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

  router.get("/runs/:id/events", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const run = store.getRun(id);
      if (!run) throw notFound(`Run not found: ${id}`);
      res.json({ events: store.listRunEvents(id) });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list run events");
    }
  });

  router.post("/runs/:id/cancel", (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const run = store.getRun(id);
      if (!run) throw notFound(`Run not found: ${id}`);
      if (!["pending", "running"].includes(run.status)) {
        throw new ApiError(409, `Run ${id} is already terminal`);
      }

      const now = new Date().toISOString();
      store.appendRunEvent(id, { type: "cancel_requested", status: run.status, message: "Cancellation requested" });
      const updated = store.updateRun(id, {
        lifecycle: { ...run.lifecycle, cancellationRequestedAt: now },
      });

      if (run.status === "pending") {
        const cancelled = store.updateRun(id, {
          status: "cancelled",
          error: "Cancelled before execution started",
          cancelledAt: now,
          lifecycle: {
            ...(updated?.lifecycle ?? run.lifecycle),
            terminalReason: "cancelled",
            terminalCause: "cancel_requested",
            failureClass: "cancelled",
            retryable: false,
          },
        });
        res.json(cancelled ?? updated ?? run);
        return;
      }

      activeRunControllers.get(id)?.abort(new DOMException("Run cancelled", "AbortError"));
      res.json(updated ?? run);
    } catch (error) {
      rethrowAsApiError(error, "Failed to cancel run");
    }
  });

  router.post("/runs/:id/retry", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const store = getInsightStore();
      const existing = store.getRun(id);
      if (!existing) throw notFound(`Run not found: ${id}`);
      if (existing.status !== "failed") {
        throw new ApiError(409, `Run ${id} must be failed to retry`);
      }
      if (!existing.lifecycle.retryable || existing.lifecycle.failureClass !== "retryable_transient") {
        throw new ApiError(409, `Run ${id} is non-retryable`);
      }

      const taskStore = requestContext.getStore();
      if (!taskStore) throw new ApiError(500, "Store context not available");
      const rootDir = taskStore.getRootDir();
      const controller = new AbortController();

      const { run } = await retryInsightRunLifecycle({
        store,
        runId: id,
        timeoutMs: typeof req.body?.timeoutMs === "number" ? req.body.timeoutMs : 120_000,
        maxAttempts: 2,
        retryDelayMs: 250,
        signal: controller.signal,
        executeAttempt: async ({ run, signal }) => {
          activeRunControllers.set(run.id, controller);
          return executeInsightAttempt({
            rootDir,
            projectId: existing.projectId,
            runId: run.id,
            signal,
            insightStore: store,
          });
        },
      });

      activeRunControllers.delete(run.id);
      res.status(201).json(run);
    } catch (error) {
      if (error instanceof InsightLifecycleError && error.code === "not_retryable") {
        throw new ApiError(409, error.message);
      }
      if (error instanceof InsightLifecycleError && error.code === "active_run_conflict") {
        throw new ApiError(409, error.message);
      }
      rethrowAsApiError(error, "Failed to retry run");
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

  // ── Update Insight ─────────────────────────────────────────────────────

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
