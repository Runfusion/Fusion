import { Router } from "express";
import type { TaskStore } from "@fusion/core";
import {
  defaultGitOps,
  ExperimentFinalizeBranchExistsError,
  ExperimentFinalizeCherryPickConflictError,
  ExperimentFinalizeMergeBaseError,
  ExperimentFinalizeNoKeptRunsError,
  ExperimentFinalizePlanError,
  ExperimentFinalizeService,
  ExperimentFinalizeStateError,
} from "@fusion/engine";
import { ApiError, catchHandler, notFound } from "./api-error.js";

function rethrowAsApiError(error: unknown, fallback = "Failed to finalize experiment session"): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof ExperimentFinalizeStateError || error instanceof ExperimentFinalizeNoKeptRunsError) {
    throw new ApiError(409, error.message, { code: error.code });
  }
  if (error instanceof ExperimentFinalizePlanError) {
    throw new ApiError(400, error.message, { code: error.code });
  }
  if (error instanceof ExperimentFinalizeMergeBaseError) {
    throw new ApiError(422, error.message, { code: error.code });
  }
  if (error instanceof ExperimentFinalizeBranchExistsError) {
    throw new ApiError(409, error.message, { code: error.code });
  }
  if (error instanceof ExperimentFinalizeCherryPickConflictError) {
    throw new ApiError(422, error.message, {
      code: error.code,
      groupId: error.groupId,
      commit: error.commit,
      stderr: error.stderr,
    });
  }
  if (error instanceof Error) throw new ApiError(500, error.message);
  throw new ApiError(500, fallback);
}

export function createExperimentRouter(store: TaskStore): Router {
  const router = Router();

  const sessionStore = store.getExperimentSessionStore();
  const service = new ExperimentFinalizeService({
    store: sessionStore,
    git: defaultGitOps(store.getRootDir()),
  });

  router.get("/:id/finalize/plan", catchHandler(async (req, res) => {
    try {
      const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const plan = await service.previewPlan({
        sessionId,
        integrationBranch: typeof req.query.integrationBranch === "string" ? req.query.integrationBranch : undefined,
      });
      res.status(200).json({ plan });
    } catch (error) {
      if (error instanceof ExperimentFinalizeStateError && /not found/i.test(error.message)) {
        throw notFound(error.message);
      }
      rethrowAsApiError(error, "Failed to preview finalize plan");
    }
  }));

  router.post("/:id/finalize", catchHandler(async (req, res) => {
    try {
      const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await service.finalize({
        sessionId,
        integrationBranch: typeof req.body?.integrationBranch === "string" ? req.body.integrationBranch : undefined,
        planOverride: req.body?.planOverride,
        summary: typeof req.body?.summary === "string" ? req.body.summary : undefined,
      });
      res.status(200).json({ result });
    } catch (error) {
      if (error instanceof ExperimentFinalizeStateError && /not found/i.test(error.message)) {
        throw notFound(error.message);
      }
      rethrowAsApiError(error);
    }
  }));

  return router;
}
