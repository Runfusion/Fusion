/**
 * Roadmap REST API Routes
 *
 * Provides CRUD endpoints for standalone roadmaps, milestones, and features.
 * Also includes AI-powered suggestion endpoints for milestone and feature creation.
 *
 * Endpoints:
 * - Roadmaps: GET /, POST /, GET /:id, PATCH /:id, DELETE /:id
 * - Milestones: GET /:roadmapId/milestones, POST /:roadmapId/milestones,
 *               PATCH /milestones/:id, DELETE /milestones/:id,
 *               POST /:roadmapId/milestones/reorder
 * - Features: GET /milestones/:milestoneId/features,
 *            POST /milestones/:milestoneId/features,
 *            PATCH /features/:id, DELETE /features/:id,
 *            POST /milestones/:milestoneId/features/reorder,
 *            POST /features/:id/move
 * - Suggestions: POST /:roadmapId/suggestions/milestones,
 *                POST /milestones/:milestoneId/suggestions/features
 */

import { Router, type Request, type Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { TaskStore } from "@fusion/core";
import {
  ApiError,
  badRequest,
  notFound,
  internalError,
} from "./api-error.js";

/**
 * Re-throws an error as an ApiError, converting unknown errors to internal errors.
 * This is used in route handlers to ensure all errors are properly typed.
 */
function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error) throw new ApiError(500, error.message);
  throw new ApiError(500, fallbackMessage);
}

import {
  generateMilestoneSuggestions,
  validateSuggestionInput,
  generateFeatureSuggestions,
  validateFeatureSuggestionInput,
  ValidationError as SuggestionValidationError,
  ParseError as SuggestionParseError,
  ServiceUnavailableError as SuggestionServiceUnavailableError,
} from "./roadmap-suggestions.js";
import { getOrCreateProjectStore } from "./project-store-resolver.js";

// ── Validation Utilities ──────────────────────────────────────────────────────

function validateTitle(title: unknown): string {
  if (!title || typeof title !== "string" || !title.trim()) {
    throw badRequest("title is required");
  }
  if (title.length > 200) {
    throw badRequest("title must not exceed 200 characters");
  }
  return title.trim();
}

function validateDescription(desc: unknown): string | undefined {
  if (desc === undefined || desc === null) return undefined;
  if (typeof desc !== "string") {
    throw badRequest("description must be a string");
  }
  if (desc.length > 5000) {
    throw badRequest("description must not exceed 5000 characters");
  }
  return desc.trim() || undefined;
}

function validateStringArray(arr: unknown, fieldName: string): string[] {
  if (!Array.isArray(arr)) {
    throw badRequest(`${fieldName} must be an array`);
  }
  if (!arr.every((item) => typeof item === "string")) {
    throw badRequest(`${fieldName} must be an array of strings`);
  }
  return arr;
}

// ── Router Factory ────────────────────────────────────────────────────────────

export function createRoadmapRouter(store: TaskStore): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<TaskStore>();

  function getProjectIdFromRequest(req: Request): string | undefined {
    if (typeof req.query.projectId === "string" && req.query.projectId.trim()) {
      return req.query.projectId;
    }
    if (req.body && typeof req.body === "object" && typeof req.body.projectId === "string" && req.body.projectId.trim()) {
      return req.body.projectId;
    }
    return undefined;
  }

  function getScopedStore(): TaskStore {
    const scoped = requestContext.getStore();
    return scoped ?? store;
  }

  router.use(async (req: Request, _res: Response, next) => {
    try {
      const projectId = getProjectIdFromRequest(req);
      const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : store;
      requestContext.run(scopedStore, next);
    } catch (error) {
      next(error);
    }
  });

  // ── Roadmap Endpoints ─────────────────────────────────────────────────────

  /**
   * GET /api/roadmaps
   * List all roadmaps.
   */
  router.get("/", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const roadmaps = roadmapStore.listRoadmaps();
      res.json(roadmaps);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to list roadmaps");
    }
  });

  /**
   * POST /api/roadmaps
   * Create a new roadmap.
   */
  router.post("/", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { title, description } = req.body as { title: string; description?: string };

      const validatedTitle = validateTitle(title);
      const validatedDesc = validateDescription(description);

      const roadmap = roadmapStore.createRoadmap({
        title: validatedTitle,
        description: validatedDesc,
      });
      res.status(201).json(roadmap);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to create roadmap");
    }
  });

  /**
   * GET /api/roadmaps/:roadmapId
   * Get a roadmap with full hierarchy (milestones and features).
   */
  router.get("/:roadmapId", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { roadmapId } = req.params;

      const roadmap = roadmapStore.getRoadmapWithHierarchy(roadmapId);
      if (!roadmap) {
        throw notFound(`Roadmap ${roadmapId} not found`);
      }

      res.json(roadmap);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to get roadmap");
    }
  });

  /**
   * PATCH /api/roadmaps/:roadmapId
   * Update roadmap metadata.
   */
  router.patch("/:roadmapId", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { roadmapId } = req.params;
      const { title, description } = req.body as { title?: string; description?: string };

      const roadmap = roadmapStore.updateRoadmap(roadmapId, {
        title: title !== undefined ? validateTitle(title) : undefined,
        description: description !== undefined ? validateDescription(description) : undefined,
      });
      res.json(roadmap);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to update roadmap");
    }
  });

  /**
   * DELETE /api/roadmaps/:roadmapId
   * Delete a roadmap and all its milestones/features.
   */
  router.delete("/:roadmapId", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { roadmapId } = req.params;

      roadmapStore.deleteRoadmap(roadmapId);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to delete roadmap");
    }
  });

  // ── Milestone Endpoints ───────────────────────────────────────────────────

  /**
   * POST /api/roadmaps/:roadmapId/milestones
   * Create a new milestone in a roadmap.
   */
  router.post("/:roadmapId/milestones", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { roadmapId } = req.params;
      const { title, description } = req.body as { title: string; description?: string };

      const validatedTitle = validateTitle(title);
      const validatedDesc = validateDescription(description);

      const milestone = roadmapStore.createMilestone(roadmapId, {
        title: validatedTitle,
        description: validatedDesc,
      });
      res.status(201).json(milestone);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to create milestone");
    }
  });

  /**
   * POST /api/roadmaps/:roadmapId/milestones/reorder
   * Reorder milestones within a roadmap.
   */
  router.post("/:roadmapId/milestones/reorder", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { roadmapId } = req.params;
      const { orderedMilestoneIds } = req.body as { orderedMilestoneIds: string[] };

      validateStringArray(orderedMilestoneIds, "orderedMilestoneIds");

      roadmapStore.reorderMilestones({ roadmapId, orderedMilestoneIds });
      res.status(204).send();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to reorder milestones");
    }
  });

  /**
   * PATCH /api/roadmaps/milestones/:milestoneId
   * Update a milestone.
   */
  router.patch("/milestones/:milestoneId", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { milestoneId } = req.params;
      const { title, description } = req.body as { title?: string; description?: string };

      const milestone = roadmapStore.updateMilestone(milestoneId, {
        title: title !== undefined ? validateTitle(title) : undefined,
        description: description !== undefined ? validateDescription(description) : undefined,
      });
      res.json(milestone);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to update milestone");
    }
  });

  /**
   * DELETE /api/roadmaps/milestones/:milestoneId
   * Delete a milestone and all its features.
   */
  router.delete("/milestones/:milestoneId", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { milestoneId } = req.params;

      roadmapStore.deleteMilestone(milestoneId);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to delete milestone");
    }
  });

  // ── Feature Endpoints ─────────────────────────────────────────────────────

  /**
   * POST /api/roadmaps/milestones/:milestoneId/features
   * Create a new feature in a milestone.
   */
  router.post("/milestones/:milestoneId/features", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { milestoneId } = req.params;
      const { title, description } = req.body as { title: string; description?: string };

      const validatedTitle = validateTitle(title);
      const validatedDesc = validateDescription(description);

      const feature = roadmapStore.createFeature(milestoneId, {
        title: validatedTitle,
        description: validatedDesc,
      });
      res.status(201).json(feature);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to create feature");
    }
  });

  /**
   * POST /api/roadmaps/milestones/:milestoneId/features/reorder
   * Reorder features within a milestone.
   */
  router.post("/milestones/:milestoneId/features/reorder", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { milestoneId } = req.params;
      const { orderedFeatureIds } = req.body as { orderedFeatureIds: string[] };

      validateStringArray(orderedFeatureIds, "orderedFeatureIds");

      // Get the milestone to find the roadmapId
      const milestone = roadmapStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound(`Milestone ${milestoneId} not found`);
      }

      roadmapStore.reorderFeatures({
        roadmapId: milestone.roadmapId,
        milestoneId,
        orderedFeatureIds,
      });
      res.status(204).send();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to reorder features");
    }
  });

  /**
   * PATCH /api/roadmaps/features/:featureId
   * Update a feature.
   */
  router.patch("/features/:featureId", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { featureId } = req.params;
      const { title, description } = req.body as { title?: string; description?: string };

      const feature = roadmapStore.updateFeature(featureId, {
        title: title !== undefined ? validateTitle(title) : undefined,
        description: description !== undefined ? validateDescription(description) : undefined,
      });
      res.json(feature);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to update feature");
    }
  });

  /**
   * DELETE /api/roadmaps/features/:featureId
   * Delete a feature.
   */
  router.delete("/features/:featureId", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { featureId } = req.params;

      roadmapStore.deleteFeature(featureId);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to delete feature");
    }
  });

  /**
   * POST /api/roadmaps/features/:featureId/move
   * Move a feature to a different milestone or position.
   */
  router.post("/features/:featureId/move", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { featureId } = req.params;
      const { targetMilestoneId, targetIndex } = req.body as {
        targetMilestoneId: string;
        targetIndex: number;
      };

      if (!targetMilestoneId) {
        throw badRequest("targetMilestoneId is required");
      }
      if (typeof targetIndex !== "number") {
        throw badRequest("targetIndex must be a number");
      }

      // Get the feature and source milestone
      const feature = roadmapStore.getFeature(featureId);
      if (!feature) {
        throw notFound(`Feature ${featureId} not found`);
      }

      const fromMilestone = roadmapStore.getMilestone(feature.milestoneId);
      if (!fromMilestone) {
        throw notFound(`Source milestone ${feature.milestoneId} not found`);
      }

      const toMilestone = roadmapStore.getMilestone(targetMilestoneId);
      if (!toMilestone) {
        throw notFound(`Target milestone ${targetMilestoneId} not found`);
      }

      roadmapStore.moveFeature({
        roadmapId: fromMilestone.roadmapId,
        featureId,
        fromMilestoneId: feature.milestoneId,
        toMilestoneId: targetMilestoneId,
        targetOrderIndex: targetIndex,
      });

      res.status(204).send();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to move feature");
    }
  });

  // ── Suggestion Endpoints ───────────────────────────────────────────────────

  /**
   * POST /api/roadmaps/:roadmapId/suggestions/milestones
   * Generate milestone suggestions using AI.
   */
  router.post("/:roadmapId/suggestions/milestones", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const scopedStore = getScopedStore();
      const { roadmapId } = req.params;

      // Check if roadmap exists
      const roadmap = roadmapStore.getRoadmap(roadmapId);
      if (!roadmap) {
        throw notFound(`Roadmap ${roadmapId} not found`);
      }

      // Validate input
      let input: { goalPrompt: string; count?: number };
      try {
        validateSuggestionInput(req.body);
        input = req.body as { goalPrompt: string; count?: number };
      } catch (err) {
        if (err instanceof SuggestionValidationError) {
          throw badRequest(err.message);
        }
        throw err;
      }

      // Get project root directory for AI context
      const rootDir = scopedStore.getRootDir();

      // Generate suggestions
      try {
        const suggestions = await generateMilestoneSuggestions(
          input.goalPrompt,
          input.count,
          rootDir
        );

        res.json({ suggestions });
      } catch (err) {
        if (err instanceof SuggestionParseError) {
          throw internalError(err.message);
        }
        if (err instanceof SuggestionServiceUnavailableError) {
          res.status(503).json({ error: err.message });
          return;
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to generate milestone suggestions");
    }
  });

  /**
   * POST /api/roadmaps/milestones/:milestoneId/suggestions/features
   * Generate feature suggestions using AI.
   */
  router.post("/milestones/:milestoneId/suggestions/features", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const scopedStore = getScopedStore();
      const { milestoneId } = req.params;

      // Get the milestone to find the roadmap
      const milestone = roadmapStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound(`Milestone ${milestoneId} not found`);
      }

      // Get the roadmap for context
      const roadmap = roadmapStore.getRoadmap(milestone.roadmapId);
      if (!roadmap) {
        throw notFound(`Roadmap ${milestone.roadmapId} not found`);
      }

      // Get existing features for this milestone
      const existingFeatures = roadmapStore.listFeatures(milestoneId);
      const existingFeatureTitles = existingFeatures.map((f) => f.title);

      // Validate input
      let input: { prompt?: string; count?: number };
      try {
        validateFeatureSuggestionInput(req.body);
        input = req.body as { prompt?: string; count?: number };
      } catch (err) {
        if (err instanceof SuggestionValidationError) {
          throw badRequest(err.message);
        }
        throw err;
      }

      // Build the context for feature suggestion
      const context = {
        roadmapTitle: roadmap.title,
        roadmapDescription: roadmap.description,
        milestoneTitle: milestone.title,
        milestoneDescription: milestone.description,
        existingFeatureTitles,
      };

      // Get project root directory for AI context
      const rootDir = scopedStore.getRootDir();

      // Generate suggestions
      try {
        const suggestions = await generateFeatureSuggestions(
          context,
          input.count,
          input.prompt,
          rootDir
        );

        res.json({ suggestions });
      } catch (err) {
        if (err instanceof SuggestionParseError) {
          throw internalError(err.message);
        }
        if (err instanceof SuggestionServiceUnavailableError) {
          res.status(503).json({ error: err.message });
          return;
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to generate feature suggestions");
    }
  });

  // ── Export / Handoff Endpoints ──────────────────────────────────────────

  /**
   * GET /api/roadmaps/:roadmapId/export
   * Get a flat export bundle for the roadmap.
   */
  router.get("/:roadmapId/export", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { roadmapId } = req.params;

      const export_ = roadmapStore.getRoadmapExport(roadmapId);
      res.json(export_);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to export roadmap");
    }
  });

  /**
   * GET /api/roadmaps/:roadmapId/handoff/mission
   * Get a mission planning handoff payload for the roadmap.
   */
  router.get("/:roadmapId/handoff/mission", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { roadmapId } = req.params;

      const handoff = roadmapStore.getRoadmapMissionHandoff(roadmapId);
      res.json(handoff);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to generate mission handoff");
    }
  });

  /**
   * GET /api/roadmaps/:roadmapId/milestones/:milestoneId/features/:featureId/handoff/task
   * Get a task planning handoff payload for a single feature.
   */
  router.get("/:roadmapId/milestones/:milestoneId/features/:featureId/handoff/task", async (req, res) => {
    try {
      const roadmapStore = getScopedStore().getRoadmapStore();
      const { roadmapId, milestoneId, featureId } = req.params;

      const handoff = roadmapStore.getRoadmapFeatureHandoff(roadmapId, milestoneId, featureId);
      res.json(handoff);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to generate task handoff");
    }
  });

  return router;
}
