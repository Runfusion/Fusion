import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import type { EvalRun, EvalTaskResult, TaskStore } from "@fusion/core";
import { ApiError, badRequest, notFound } from "./api-error.js";
import { getScopedStore as resolveScopedRequestStore } from "./routes/context.js";
import type { ServerOptions } from "./server.js";

function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error) throw new ApiError(500, error.message);
  throw new ApiError(500, fallbackMessage);
}

function parseOptionalInt(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw badRequest(`Invalid ${key}`);
  }
  return parsed;
}

function normalizeEvalText(result: EvalTaskResult): string {
  return [
    result.id,
    result.taskId,
    result.runId,
    result.taskSnapshot.title,
    result.taskSnapshot.summary,
    result.summary,
    result.rationale,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ").toLowerCase();
}

export function createEvalsRouter(store: TaskStore, options?: ServerOptions): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<TaskStore>();

  router.use((req: Request, _res: Response, next: NextFunction) => {
    // FNXC:CentralProjectIdentity 2026-07-13-23:54:
    // Resolve an explicit central-registry project id via the shared seam
    // (request id → registered launch project id → raw launch store last resort).
    // FNXC:CentralProjectIdentity 2026-07-14-00:15:
    // Catch-and-FORWARD via next(): rethrowAsApiError throws, and a throw inside this
    // detached promise chain escapes Express (it is not the request's synchronous
    // call stack), so a store-resolution failure would hang the request instead of
    // returning an error. Mirror the insights/goals routers' pattern.
    resolveScopedRequestStore(req, store, options)
      .then((scopedStore) => requestContext.run(scopedStore, () => next()))
      .catch((err) => {
        try {
          rethrowAsApiError(err, "Failed to get project store");
        } catch (apiError) {
          next(apiError);
        }
      });
  });

  function getEvalStore() {
    const scopedStore = requestContext.getStore();
    if (!scopedStore) throw new ApiError(500, "Store context not available");
    return scopedStore.getEvalStore();
  }

  // FNXC:Evals 2026-06-27-12:35:
  // getEvalStore() returns EvalStore | AsyncEvalStore (PG backend mode), so the
  // handlers await the store calls — await resolves both the sync arrays and the
  // AsyncEvalStore promises. Previously the sync-only path 500'd in PG mode.
  router.get("/runs", async (req: Request, res: Response) => {
    try {
      const evalStore = getEvalStore();
      const runs = (await evalStore.listRuns()).map((run: EvalRun) => ({
        id: run.id,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
        status: run.status,
        evaluatedTaskCount: run.counts.scoredTasks,
        counts: run.counts,
        trigger: run.trigger,
      }));
      res.json({ runs });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list eval runs");
    }
  });

  router.get("/:id", async (req: Request, res: Response) => {
    try {
      const evalStore = getEvalStore();
      const evalId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await evalStore.getTaskResult(evalId);
      if (!result) throw notFound(`Eval result not found: ${evalId}`);
      res.json({ result });
    } catch (error) {
      rethrowAsApiError(error, "Failed to get eval result");
    }
  });

  router.get("/", async (req: Request, res: Response) => {
    try {
      const evalStore = getEvalStore();
      const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
      const runId = typeof req.query.runId === "string" && req.query.runId.trim() ? req.query.runId : undefined;
      const scoreMin = parseOptionalInt(req.query.scoreMin, "scoreMin");
      const scoreMax = parseOptionalInt(req.query.scoreMax, "scoreMax");
      const limit = parseOptionalInt(req.query.limit, "limit") ?? 100;
      const offset = parseOptionalInt(req.query.offset, "offset") ?? 0;

      if (scoreMin !== undefined && (scoreMin < 0 || scoreMin > 100)) throw badRequest("scoreMin must be between 0 and 100");
      if (scoreMax !== undefined && (scoreMax < 0 || scoreMax > 100)) throw badRequest("scoreMax must be between 0 and 100");
      if (scoreMin !== undefined && scoreMax !== undefined && scoreMin > scoreMax) throw badRequest("scoreMin cannot exceed scoreMax");
      if (limit < 1) throw badRequest("Invalid limit");
      if (offset < 0) throw badRequest("Invalid offset");

      let results = await evalStore.listTaskResults({ runId });
      results = results.filter((result) => {
        if (scoreMin !== undefined && (result.overallScore ?? -1) < scoreMin) return false;
        if (scoreMax !== undefined && (result.overallScore ?? 101) > scoreMax) return false;
        if (q && !normalizeEvalText(result).includes(q)) return false;
        return true;
      });

      results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const count = results.length;
      results = results.slice(offset, offset + limit);

      res.json({ results, count });
    } catch (error) {
      rethrowAsApiError(error, "Failed to list eval results");
    }
  });

  return router;
}
