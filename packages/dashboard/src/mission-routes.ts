/**
 * Mission REST API Routes
 *
 * Provides CRUD endpoints for missions, milestones, slices, and features.
 * Also includes interview system endpoints for AI-assisted mission planning.
 *
 * Endpoints:
 * - Missions: GET /, POST /, GET /:id, PATCH /:id, DELETE /:id, GET /:id/status
 * - Milestones: GET /:missionId/milestones, POST /:missionId/milestones, etc.
 * - Slices: GET /milestones/:milestoneId/slices, POST /milestones/:milestoneId/slices, etc.
 * - Features: GET /slices/:sliceId/features, POST /slices/:sliceId/features, etc.
 * - Interview: POST /interview/start, POST /interview/respond, etc.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { TaskStore } from "@fusion/core";
import { getOrCreateProjectStore } from "./project-store-resolver.js";
import type {
  Mission,
  Milestone,
  Slice,
  MissionFeature,
  MissionCreateInput,
  MilestoneCreateInput,
  SliceCreateInput,
  FeatureCreateInput,
  MissionStatus,
  MilestoneStatus,
  SliceStatus,
  FeatureStatus,
  InterviewState,
} from "@fusion/core";
import {
  MISSION_STATUSES,
  MILESTONE_STATUSES,
  SLICE_STATUSES,
  FEATURE_STATUSES,
  INTERVIEW_STATES,
} from "@fusion/core";

// ── Validation Utilities ────────────────────────────────────────────────────

function validateUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function validateMissionId(id: string): boolean {
  // Accept generated format: M-{base36timestamp}-{random} (e.g. M-LZ7DN0-A2B5)
  // and legacy numeric format: M-{digits} (e.g. M-001)
  return /^M-[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(id);
}

function validateMilestoneId(id: string): boolean {
  return /^MS-[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(id);
}

function validateSliceId(id: string): boolean {
  return /^SL-[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(id);
}

function validateFeatureId(id: string): boolean {
  return /^F-[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(id);
}

function validateTitle(title: unknown): string {
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    throw new Error("Title is required and must be a non-empty string");
  }
  if (title.length > 200) throw new Error("Title must not exceed 200 characters");
  return title.trim();
}

function validateDescription(desc: unknown): string | undefined {
  if (desc === undefined || desc === null) return undefined;
  if (typeof desc !== "string") throw new Error("Description must be a string");
  if (desc.length > 5000) throw new Error("Description must not exceed 5000 characters");
  return desc.trim() || undefined;
}

function validateStatus(status: unknown, allowedStatuses: readonly string[]): string {
  if (!status || typeof status !== "string") {
    throw new Error(`Status is required and must be one of: ${allowedStatuses.join(", ")}`);
  }
  if (!allowedStatuses.includes(status)) {
    throw new Error(`Invalid status. Must be one of: ${allowedStatuses.join(", ")}`);
  }
  return status;
}

function validateInterviewState(state: unknown): InterviewState {
  if (!state || typeof state !== "string") {
    throw new Error(`Interview state is required and must be one of: ${INTERVIEW_STATES.join(", ")}`);
  }
  if (!INTERVIEW_STATES.includes(state as InterviewState)) {
    throw new Error(`Invalid interview state. Must be one of: ${INTERVIEW_STATES.join(", ")}`);
  }
  return state as InterviewState;
}

function validateStringArray(arr: unknown, fieldName: string): string[] {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) throw new Error(`${fieldName} must be an array`);
  if (!arr.every((item) => typeof item === "string")) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  return arr;
}

function validateBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function validateOrderedIds(body: unknown): string[] {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must contain orderedIds array");
  }
  const { orderedIds } = body as Record<string, unknown>;
  if (!Array.isArray(orderedIds)) {
    throw new Error("orderedIds must be an array");
  }
  if (!orderedIds.every((id) => typeof id === "string")) {
    throw new Error("orderedIds must be an array of strings");
  }
  return orderedIds;
}

// ── Async Handler Wrapper ───────────────────────────────────────────────────

type TypedRequest = Request<Record<string, string>>;

function asyncHandler(fn: (req: TypedRequest, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as TypedRequest, res, next)).catch(next);
  };
}

// ── Router Factory ──────────────────────────────────────────────────────────

export function createMissionRouter(store: TaskStore): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<ReturnType<TaskStore["getMissionStore"]>>();

  function getProjectIdFromRequest(req: Request): string | undefined {
    if (typeof req.query.projectId === "string" && req.query.projectId.trim()) {
      return req.query.projectId;
    }
    if (req.body && typeof req.body === "object" && typeof req.body.projectId === "string" && req.body.projectId.trim()) {
      return req.body.projectId;
    }
    return undefined;
  }

  function getScopedMissionStore() {
    const missionStore = requestContext.getStore();
    if (!missionStore) {
      return store.getMissionStore();
    }
    return missionStore;
  }

  const missionStore = new Proxy({} as ReturnType<TaskStore["getMissionStore"]>, {
    get(_target, property) {
      const target = getScopedMissionStore();
      const value = (target as unknown as Record<PropertyKey, unknown>)[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  router.use(async (req, _res, next) => {
    try {
      const projectId = getProjectIdFromRequest(req);
      const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : store;
      requestContext.run(scopedStore.getMissionStore(), next);
    } catch (error) {
      next(error);
    }
  });

  // ── Mission Endpoints ─────────────────────────────────────────────────────

  /**
   * GET /api/missions
   * List all missions ordered by createdAt desc
   */
  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const missions = missionStore.listMissions();
      // Sort by createdAt desc
      missions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(missions);
    })
  );

  /**
   * POST /api/missions
   * Create a new mission
   */
  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const { title, description, autoAdvance } = req.body;

      const validatedTitle = validateTitle(title);
      const validatedDescription = validateDescription(description);

      const input: MissionCreateInput = {
        title: validatedTitle,
        description: validatedDescription,
      };

      const mission = missionStore.createMission(input);

      if (autoAdvance !== undefined) {
        const updatedMission = missionStore.updateMission(mission.id, {
          autoAdvance: validateBoolean(autoAdvance, "autoAdvance"),
        });
        res.status(201).json(updatedMission);
        return;
      }

      res.status(201).json(mission);
    })
  );

  /**
   * GET /api/missions/:missionId
   * Get mission by ID with full hierarchy
   */
  router.get(
    "/:missionId",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const mission = missionStore.getMissionWithHierarchy(missionId);
      if (!mission) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      res.json(mission);
    })
  );

  /**
   * PATCH /api/missions/:missionId
   * Update mission fields
   */
  router.patch(
    "/:missionId",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;
      const { title, description, status, autoAdvance } = req.body;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const updates: Partial<Mission> = {};

      if (title !== undefined) {
        updates.title = validateTitle(title);
      }
      if (description !== undefined) {
        updates.description = validateDescription(description);
      }
      if (status !== undefined) {
        updates.status = validateStatus(status, MISSION_STATUSES) as MissionStatus;
      }
      if (autoAdvance !== undefined) {
        updates.autoAdvance = validateBoolean(autoAdvance, "autoAdvance");
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
      }

      try {
        const mission = missionStore.updateMission(missionId, updates);
        res.json(mission);
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          res.status(404).json({ error: "Mission not found" });
          return;
        }
        throw err;
      }
    })
  );

  /**
   * DELETE /api/missions/:missionId
   * Delete mission (cascades via FK)
   */
  router.delete(
    "/:missionId",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const existing = missionStore.getMission(missionId);
      if (!existing) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      missionStore.deleteMission(missionId);
      res.status(204).send();
    })
  );

  /**
   * GET /api/missions/:missionId/status
   * Get computed status rollup
   */
  router.get(
    "/:missionId/status",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      const status = missionStore.computeMissionStatus(missionId);
      res.json({ status });
    })
  );

  // ── Interview State Endpoints (Mission) ────────────────────────────────────

  /**
   * GET /api/missions/:missionId/interview-state
   * Get current interview state for mission
   */
  router.get(
    "/:missionId/interview-state",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      res.json({ state: mission.interviewState });
    })
  );

  /**
   * POST /api/missions/:missionId/interview-state
   * Update interview state for mission
   */
  router.post(
    "/:missionId/interview-state",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;
      const { state } = req.body;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const validatedState = validateInterviewState(state);

      try {
        const mission = missionStore.updateMissionInterviewState(missionId, validatedState);
        res.json(mission);
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          res.status(404).json({ error: "Mission not found" });
          return;
        }
        throw err;
      }
    })
  );

  // ── Milestone Endpoints ────────────────────────────────────────────────────

  /**
   * GET /api/missions/:missionId/milestones
   * List milestones for mission
   */
  router.get(
    "/:missionId/milestones",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      const milestones = missionStore.listMilestones(missionId);
      // Sort by orderIndex
      milestones.sort((a, b) => a.orderIndex - b.orderIndex);
      res.json(milestones);
    })
  );

  /**
   * POST /api/missions/:missionId/milestones
   * Add milestone to mission
   */
  router.post(
    "/:missionId/milestones",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;
      const { title, description, dependencies } = req.body;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      const validatedTitle = validateTitle(title);
      const validatedDescription = validateDescription(description);
      const validatedDependencies = validateStringArray(dependencies, "dependencies");

      const input: MilestoneCreateInput = {
        title: validatedTitle,
        description: validatedDescription,
        dependencies: validatedDependencies,
      };

      const milestone = missionStore.addMilestone(missionId, input);
      res.status(201).json(milestone);
    })
  );

  /**
   * POST /api/missions/:missionId/milestones/reorder
   * Reorder milestones in mission
   */
  router.post(
    "/:missionId/milestones/reorder",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      const orderedIds = validateOrderedIds(req.body);

      // Validate all IDs belong to this mission
      const existingMilestones = missionStore.listMilestones(missionId);
      const existingIds = new Set(existingMilestones.map((m) => m.id));
      const allIdsValid = orderedIds.every((id) => existingIds.has(id));

      if (!allIdsValid) {
        res.status(400).json({ error: "Invalid milestone IDs in orderedIds" });
        return;
      }

      if (orderedIds.length !== existingIds.size) {
        res.status(400).json({ error: "orderedIds must include all milestones" });
        return;
      }

      missionStore.reorderMilestones(missionId, orderedIds);
      res.status(204).send();
    })
  );

  /**
   * GET /api/missions/milestones/:milestoneId
   * Get milestone by ID
   */
  router.get(
    "/milestones/:milestoneId",
    asyncHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        res.status(400).json({ error: "Invalid milestone ID format" });
        return;
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        res.status(404).json({ error: "Milestone not found" });
        return;
      }

      res.json(milestone);
    })
  );

  /**
   * PATCH /api/missions/milestones/:milestoneId
   * Update milestone fields
   */
  router.patch(
    "/milestones/:milestoneId",
    asyncHandler(async (req, res) => {
      const { milestoneId } = req.params;
      const { title, description, status, dependencies } = req.body;

      if (!validateMilestoneId(milestoneId)) {
        res.status(400).json({ error: "Invalid milestone ID format" });
        return;
      }

      const updates: Partial<Milestone> = {};

      if (title !== undefined) {
        updates.title = validateTitle(title);
      }
      if (description !== undefined) {
        updates.description = validateDescription(description);
      }
      if (status !== undefined) {
        updates.status = validateStatus(status, MILESTONE_STATUSES) as MilestoneStatus;
      }
      if (dependencies !== undefined) {
        updates.dependencies = validateStringArray(dependencies, "dependencies");
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
      }

      try {
        const milestone = missionStore.updateMilestone(milestoneId, updates);
        res.json(milestone);
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          res.status(404).json({ error: "Milestone not found" });
          return;
        }
        throw err;
      }
    })
  );

  /**
   * DELETE /api/missions/milestones/:milestoneId
   * Delete milestone
   */
  router.delete(
    "/milestones/:milestoneId",
    asyncHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        res.status(400).json({ error: "Invalid milestone ID format" });
        return;
      }

      const existing = missionStore.getMilestone(milestoneId);
      if (!existing) {
        res.status(404).json({ error: "Milestone not found" });
        return;
      }

      missionStore.deleteMilestone(milestoneId);
      res.status(204).send();
    })
  );

  // ── Interview State Endpoints (Milestone) ────────────────────────────────

  /**
   * GET /api/missions/milestones/:milestoneId/interview-state
   * Get milestone interview state
   */
  router.get(
    "/milestones/:milestoneId/interview-state",
    asyncHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        res.status(400).json({ error: "Invalid milestone ID format" });
        return;
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        res.status(404).json({ error: "Milestone not found" });
        return;
      }

      res.json({ state: milestone.interviewState });
    })
  );

  /**
   * POST /api/missions/milestones/:milestoneId/interview-state
   * Update milestone interview state
   */
  router.post(
    "/milestones/:milestoneId/interview-state",
    asyncHandler(async (req, res) => {
      const { milestoneId } = req.params;
      const { state } = req.body;

      if (!validateMilestoneId(milestoneId)) {
        res.status(400).json({ error: "Invalid milestone ID format" });
        return;
      }

      const validatedState = validateInterviewState(state);

      try {
        const milestone = missionStore.updateMilestoneInterviewState(milestoneId, validatedState);
        res.json(milestone);
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          res.status(404).json({ error: "Milestone not found" });
          return;
        }
        throw err;
      }
    })
  );

  // ── Slice Endpoints ────────────────────────────────────────────────────────

  /**
   * GET /api/missions/milestones/:milestoneId/slices
   * List slices for milestone
   */
  router.get(
    "/milestones/:milestoneId/slices",
    asyncHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        res.status(400).json({ error: "Invalid milestone ID format" });
        return;
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        res.status(404).json({ error: "Milestone not found" });
        return;
      }

      const slices = missionStore.listSlices(milestoneId);
      // Sort by orderIndex
      slices.sort((a, b) => a.orderIndex - b.orderIndex);
      res.json(slices);
    })
  );

  /**
   * POST /api/missions/milestones/:milestoneId/slices
   * Add slice to milestone
   */
  router.post(
    "/milestones/:milestoneId/slices",
    asyncHandler(async (req, res) => {
      const { milestoneId } = req.params;
      const { title, description } = req.body;

      if (!validateMilestoneId(milestoneId)) {
        res.status(400).json({ error: "Invalid milestone ID format" });
        return;
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        res.status(404).json({ error: "Milestone not found" });
        return;
      }

      const validatedTitle = validateTitle(title);
      const validatedDescription = validateDescription(description);

      const input: SliceCreateInput = {
        title: validatedTitle,
        description: validatedDescription,
      };

      const slice = missionStore.addSlice(milestoneId, input);
      res.status(201).json(slice);
    })
  );

  /**
   * POST /api/missions/milestones/:milestoneId/slices/reorder
   * Reorder slices in milestone
   */
  router.post(
    "/milestones/:milestoneId/slices/reorder",
    asyncHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        res.status(400).json({ error: "Invalid milestone ID format" });
        return;
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        res.status(404).json({ error: "Milestone not found" });
        return;
      }

      const orderedIds = validateOrderedIds(req.body);

      // Validate all IDs belong to this milestone
      const existingSlices = missionStore.listSlices(milestoneId);
      const existingIds = new Set(existingSlices.map((s) => s.id));
      const allIdsValid = orderedIds.every((id) => existingIds.has(id));

      if (!allIdsValid) {
        res.status(400).json({ error: "Invalid slice IDs in orderedIds" });
        return;
      }

      if (orderedIds.length !== existingIds.size) {
        res.status(400).json({ error: "orderedIds must include all slices" });
        return;
      }

      missionStore.reorderSlices(milestoneId, orderedIds);
      res.status(204).send();
    })
  );

  /**
   * GET /api/missions/slices/:sliceId
   * Get slice by ID
   */
  router.get(
    "/slices/:sliceId",
    asyncHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        res.status(400).json({ error: "Invalid slice ID format" });
        return;
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        res.status(404).json({ error: "Slice not found" });
        return;
      }

      res.json(slice);
    })
  );

  /**
   * PATCH /api/missions/slices/:sliceId
   * Update slice fields
   */
  router.patch(
    "/slices/:sliceId",
    asyncHandler(async (req, res) => {
      const { sliceId } = req.params;
      const { title, description, status } = req.body;

      if (!validateSliceId(sliceId)) {
        res.status(400).json({ error: "Invalid slice ID format" });
        return;
      }

      const updates: Partial<Slice> = {};

      if (title !== undefined) {
        updates.title = validateTitle(title);
      }
      if (description !== undefined) {
        updates.description = validateDescription(description);
      }
      if (status !== undefined) {
        updates.status = validateStatus(status, SLICE_STATUSES) as SliceStatus;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
      }

      try {
        const slice = missionStore.updateSlice(sliceId, updates);
        res.json(slice);
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          res.status(404).json({ error: "Slice not found" });
          return;
        }
        throw err;
      }
    })
  );

  /**
   * DELETE /api/missions/slices/:sliceId
   * Delete slice
   */
  router.delete(
    "/slices/:sliceId",
    asyncHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        res.status(400).json({ error: "Invalid slice ID format" });
        return;
      }

      const existing = missionStore.getSlice(sliceId);
      if (!existing) {
        res.status(404).json({ error: "Slice not found" });
        return;
      }

      missionStore.deleteSlice(sliceId);
      res.status(204).send();
    })
  );

  /**
   * POST /api/missions/slices/:sliceId/activate
   * Activate slice
   */
  router.post(
    "/slices/:sliceId/activate",
    asyncHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        res.status(400).json({ error: "Invalid slice ID format" });
        return;
      }

      try {
        const slice = missionStore.activateSlice(sliceId);
        res.json(slice);
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          res.status(404).json({ error: "Slice not found" });
          return;
        }
        throw err;
      }
    })
  );

  // ── Feature Endpoints ──────────────────────────────────────────────────────

  /**
   * GET /api/missions/slices/:sliceId/features
   * List features for slice
   */
  router.get(
    "/slices/:sliceId/features",
    asyncHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        res.status(400).json({ error: "Invalid slice ID format" });
        return;
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        res.status(404).json({ error: "Slice not found" });
        return;
      }

      const features = missionStore.listFeatures(sliceId);
      res.json(features);
    })
  );

  /**
   * POST /api/missions/slices/:sliceId/features
   * Add feature to slice
   */
  router.post(
    "/slices/:sliceId/features",
    asyncHandler(async (req, res) => {
      const { sliceId } = req.params;
      const { title, description, acceptanceCriteria } = req.body;

      if (!validateSliceId(sliceId)) {
        res.status(400).json({ error: "Invalid slice ID format" });
        return;
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        res.status(404).json({ error: "Slice not found" });
        return;
      }

      const validatedTitle = validateTitle(title);
      const validatedDescription = validateDescription(description);
      const validatedCriteria = validateDescription(acceptanceCriteria);

      const input: FeatureCreateInput = {
        title: validatedTitle,
        description: validatedDescription,
        acceptanceCriteria: validatedCriteria,
      };

      const feature = missionStore.addFeature(sliceId, input);
      res.status(201).json(feature);
    })
  );

  /**
   * GET /api/missions/features/:featureId
   * Get feature by ID
   */
  router.get(
    "/features/:featureId",
    asyncHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        res.status(400).json({ error: "Invalid feature ID format" });
        return;
      }

      const feature = missionStore.getFeature(featureId);
      if (!feature) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      res.json(feature);
    })
  );

  /**
   * PATCH /api/missions/features/:featureId
   * Update feature fields
   */
  router.patch(
    "/features/:featureId",
    asyncHandler(async (req, res) => {
      const { featureId } = req.params;
      const { title, description, acceptanceCriteria, status } = req.body;

      if (!validateFeatureId(featureId)) {
        res.status(400).json({ error: "Invalid feature ID format" });
        return;
      }

      const updates: Partial<MissionFeature> = {};

      if (title !== undefined) {
        updates.title = validateTitle(title);
      }
      if (description !== undefined) {
        updates.description = validateDescription(description);
      }
      if (acceptanceCriteria !== undefined) {
        updates.acceptanceCriteria = validateDescription(acceptanceCriteria);
      }
      if (status !== undefined) {
        updates.status = validateStatus(status, FEATURE_STATUSES) as FeatureStatus;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No valid fields to update" });
        return;
      }

      try {
        const feature = missionStore.updateFeature(featureId, updates);
        res.json(feature);
      } catch (err: any) {
        if (err.message?.includes("not found")) {
          res.status(404).json({ error: "Feature not found" });
          return;
        }
        throw err;
      }
    })
  );

  /**
   * DELETE /api/missions/features/:featureId
   * Delete feature
   */
  router.delete(
    "/features/:featureId",
    asyncHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        res.status(400).json({ error: "Invalid feature ID format" });
        return;
      }

      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      missionStore.deleteFeature(featureId);
      res.status(204).send();
    })
  );

  /**
   * POST /api/missions/features/:featureId/link-task
   * Link feature to task
   */
  router.post(
    "/features/:featureId/link-task",
    asyncHandler(async (req, res) => {
      const { featureId } = req.params;
      const { taskId } = req.body;

      if (!validateFeatureId(featureId)) {
        res.status(400).json({ error: "Invalid feature ID format" });
        return;
      }

      if (!taskId || typeof taskId !== "string") {
        res.status(400).json({ error: "taskId is required and must be a string" });
        return;
      }

      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      try {
        const feature = missionStore.linkFeatureToTask(featureId, taskId);
        res.json(feature);
      } catch (err: any) {
        if (err.message?.includes("already linked")) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
    })
  );

  /**
   * POST /api/missions/features/:featureId/unlink-task
   * Unlink feature from task
   */
  router.post(
    "/features/:featureId/unlink-task",
    asyncHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        res.status(400).json({ error: "Invalid feature ID format" });
        return;
      }

      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      if (!existing.taskId) {
        res.status(400).json({ error: "Feature is not linked to a task" });
        return;
      }

      const feature = missionStore.unlinkFeatureFromTask(featureId);
      res.json(feature);
    })
  );

  // ── Feature Triage Endpoints ────────────────────────────────────────────────

  /**
   * POST /api/missions/features/:featureId/triage
   * Triage a feature by creating a task and linking it.
   * Body: { taskTitle?: string, taskDescription?: string }
   */
  router.post(
    "/features/:featureId/triage",
    asyncHandler(async (req, res) => {
      const { featureId } = req.params;
      const { taskTitle, taskDescription } = req.body || {};

      if (!validateFeatureId(featureId)) {
        res.status(400).json({ error: "Invalid feature ID format" });
        return;
      }

      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      try {
        const feature = await missionStore.triageFeature(
          featureId,
          taskTitle || undefined,
          taskDescription || undefined,
        );
        res.json(feature);
      } catch (err: any) {
        if (err.message?.includes("already")) {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err.message?.includes("TaskStore")) {
          res.status(503).json({ error: "TaskStore not available for triage operations" });
          return;
        }
        throw err;
      }
    })
  );

  /**
   * POST /api/missions/slices/:sliceId/triage-all
   * Triage all "defined" features in a slice.
   * Returns: { triaged: MissionFeature[], count: number }
   */
  router.post(
    "/slices/:sliceId/triage-all",
    asyncHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        res.status(400).json({ error: "Invalid slice ID format" });
        return;
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        res.status(404).json({ error: "Slice not found" });
        return;
      }

      try {
        const triaged = await missionStore.triageSlice(sliceId);
        res.json({ triaged, count: triaged.length });
      } catch (err: any) {
        if (err.message?.includes("TaskStore")) {
          res.status(503).json({ error: "TaskStore not available for triage operations" });
          return;
        }
        throw err;
      }
    })
  );

  // ── Mission Pause/Stop/Resume Endpoints ─────────────────────────────────────

  /**
   * POST /api/missions/:missionId/pause
   * Pause a mission by setting status to "blocked".
   * In-flight tasks continue running; no new tasks are scheduled.
   */
  router.post(
    "/:missionId/pause",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      if (mission.status === "blocked") {
        res.status(400).json({ error: "Mission is already paused (blocked)" });
        return;
      }

      const updated = missionStore.updateMission(missionId, { status: "blocked" });
      res.json(updated);
    })
  );

  /**
   * POST /api/missions/:missionId/resume
   * Resume a paused mission by setting status to "active".
   */
  router.post(
    "/:missionId/resume",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      if (mission.status !== "blocked") {
        res.status(400).json({ error: "Mission is not paused (status must be 'blocked' to resume)" });
        return;
      }

      const updated = missionStore.updateMission(missionId, { status: "active" });
      res.json(updated);
    })
  );

  /**
   * POST /api/missions/:missionId/stop
   * Stop a mission: set status to "blocked" and pause all linked tasks.
   */
  router.post(
    "/:missionId/stop",
    asyncHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        res.status(400).json({ error: "Invalid mission ID format" });
        return;
      }

      const hierarchy = missionStore.getMissionWithHierarchy(missionId);
      if (!hierarchy) {
        res.status(404).json({ error: "Mission not found" });
        return;
      }

      // Set mission status to blocked
      const updated = missionStore.updateMission(missionId, { status: "blocked" });

      // Pause all tasks linked to features in this mission
      const pausedTaskIds: string[] = [];
      for (const milestone of hierarchy.milestones) {
        for (const slice of milestone.slices) {
          for (const feature of slice.features) {
            if (feature.taskId) {
              try {
                await store.pauseTask(feature.taskId, true);
                pausedTaskIds.push(feature.taskId);
              } catch (err: any) {
                // Log but don't fail — task may already be paused or not found
              }
            }
          }
        }
      }

      res.json({ ...updated, pausedTaskIds });
    })
  );

  // ── Interview Endpoints ─────────────────────────────────────────────────────
  // Note: These are mounted at /api/missions/interview/* via the router

  /**
   * Helper to resolve rootDir for the current request's project scope.
   */
  async function getRootDirForRequest(req: TypedRequest): Promise<string> {
    const projectId = getProjectIdFromRequest(req);
    const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : store;
    return scopedStore.getRootDir();
  }

  /**
   * POST /api/missions/interview/start
   * Start a mission interview session with AI agent streaming.
   * Body: { missionTitle: string }
   * Returns: { sessionId: string }
   */
  router.post(
    "/interview/start",
    asyncHandler(async (req, res) => {
      const { missionTitle } = req.body;

      if (!missionTitle || typeof missionTitle !== "string" || !missionTitle.trim()) {
        res.status(400).json({ error: "missionTitle is required and must be a non-empty string" });
        return;
      }

      if (missionTitle.length > 500) {
        res.status(400).json({ error: "missionTitle must be 500 characters or less" });
        return;
      }

      try {
        const ip = req.ip || req.socket.remoteAddress || "unknown";
        const rootDir = await getRootDirForRequest(req);

        const {
          createMissionInterviewSession,
          RateLimitError,
        } = await import("./mission-interview.js");

        const sessionId = await createMissionInterviewSession(ip, missionTitle.trim(), rootDir);
        res.status(201).json({ sessionId });
      } catch (err: any) {
        if (err.name === "RateLimitError") {
          res.status(429).json({ error: err.message });
        } else {
          res.status(500).json({ error: err.message || "Failed to start interview session" });
        }
      }
    })
  );

  /**
   * POST /api/missions/interview/respond
   * Submit response to interview question.
   * Body: { sessionId: string, responses: Record<string, unknown> }
   */
  router.post(
    "/interview/respond",
    asyncHandler(async (req, res) => {
      const { sessionId, responses } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      if (!responses || typeof responses !== "object") {
        res.status(400).json({ error: "responses is required and must be an object" });
        return;
      }

      try {
        const {
          submitMissionInterviewResponse,
          SessionNotFoundError,
          InvalidSessionStateError,
        } = await import("./mission-interview.js");

        const result = await submitMissionInterviewResponse(sessionId, responses);
        res.json(result);
      } catch (err: any) {
        if (err.name === "SessionNotFoundError") {
          res.status(404).json({ error: err.message });
        } else if (err.name === "InvalidSessionStateError") {
          res.status(400).json({ error: err.message });
        } else {
          res.status(500).json({ error: err.message || "Failed to process response" });
        }
      }
    })
  );

  /**
   * POST /api/missions/interview/cancel
   * Cancel and cleanup an interview session.
   * Body: { sessionId: string }
   */
  router.post(
    "/interview/cancel",
    asyncHandler(async (req, res) => {
      const { sessionId } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      try {
        const {
          cancelMissionInterviewSession,
          SessionNotFoundError,
        } = await import("./mission-interview.js");

        await cancelMissionInterviewSession(sessionId);
        res.json({ success: true });
      } catch (err: any) {
        if (err.name === "SessionNotFoundError") {
          res.status(404).json({ error: err.message });
        } else {
          res.status(500).json({ error: err.message || "Failed to cancel session" });
        }
      }
    })
  );

  /**
   * GET /api/missions/interview/:sessionId/stream
   * SSE endpoint for real-time interview session updates.
   * Streams thinking output, questions, summaries, and errors.
   */
  router.get(
    "/interview/:sessionId/stream",
    asyncHandler(async (req, res) => {
      const { sessionId } = req.params;

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Send initial connection confirmation
      res.write(": connected\n\n");

      try {
        const {
          missionInterviewStreamManager,
          getMissionInterviewSession,
        } = await import("./mission-interview.js");

        // Verify session exists
        const session = getMissionInterviewSession(sessionId);
        if (!session) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: "Session not found or expired" })}\n\n`);
          res.end();
          return;
        }

        // Subscribe to session events
        const unsubscribe = missionInterviewStreamManager.subscribe(sessionId, (event) => {
          try {
            const data = (event as { data?: unknown }).data;
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);

            // End stream on complete or error
            if (event.type === "complete" || event.type === "error") {
              unsubscribe();
              res.end();
            }
          } catch {
            // Client disconnected
            unsubscribe();
          }
        });

        // Handle client disconnect
        req.on("close", () => {
          unsubscribe();
        });

        // Heartbeat every 30s
        const heartbeat = setInterval(() => {
          if (res.writableEnded) {
            clearInterval(heartbeat);
            return;
          }
          res.write(": heartbeat\n\n");
        }, 30_000);

        req.on("close", () => {
          clearInterval(heartbeat);
        });
      } catch (err: any) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: err.message || "Stream error" })}\n\n`);
        res.end();
      }
    })
  );

  /**
   * POST /api/missions/interview/create-mission
   * Create mission with full hierarchy from completed interview.
   * Body: { sessionId: string, summary?: MissionPlanSummary }
   * Returns: MissionWithHierarchy
   */
  router.post(
    "/interview/create-mission",
    asyncHandler(async (req, res) => {
      const { sessionId, summary: editedSummary } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }

      try {
        const {
          getMissionInterviewSession,
          getMissionInterviewSummary,
          cleanupMissionInterviewSession,
          SessionNotFoundError,
        } = await import("./mission-interview.js");

        const session = getMissionInterviewSession(sessionId);
        if (!session) {
          res.status(404).json({ error: `Interview session ${sessionId} not found or expired` });
          return;
        }

        // Use edited summary if provided, otherwise use the session's generated summary
        const summary = editedSummary || getMissionInterviewSummary(sessionId);
        if (!summary || !Array.isArray(summary.milestones)) {
          res.status(400).json({ error: "Interview session is not complete or summary is missing" });
          return;
        }

        // Create the full mission hierarchy
        const mission = missionStore.createMission({
          title: summary.missionTitle || session.missionTitle,
          description: summary.missionDescription,
        });

        // Update interview state to completed
        missionStore.updateMission(mission.id, { interviewState: "completed" as InterviewState });

        // Create milestones, slices, and features
        // Verification criteria are appended to descriptions since the schema
        // doesn't have dedicated verification fields yet.
        for (const milestoneData of summary.milestones) {
          let msDesc = milestoneData.description || "";
          if (milestoneData.verification) {
            msDesc += msDesc ? "\n\n" : "";
            msDesc += `**Verification:** ${milestoneData.verification}`;
          }
          const milestone = missionStore.addMilestone(mission.id, {
            title: milestoneData.title,
            description: msDesc || undefined,
          });

          if (Array.isArray(milestoneData.slices)) {
            for (const sliceData of milestoneData.slices) {
              let slDesc = sliceData.description || "";
              if (sliceData.verification) {
                slDesc += slDesc ? "\n\n" : "";
                slDesc += `**Verification:** ${sliceData.verification}`;
              }
              const slice = missionStore.addSlice(milestone.id, {
                title: sliceData.title,
                description: slDesc || undefined,
              });

              if (Array.isArray(sliceData.features)) {
                for (const featureData of sliceData.features) {
                  missionStore.addFeature(slice.id, {
                    title: featureData.title,
                    description: featureData.description,
                    acceptanceCriteria: featureData.acceptanceCriteria,
                  });
                }
              }
            }
          }
        }

        // Cleanup the interview session
        cleanupMissionInterviewSession(sessionId);

        // Return the full hierarchy
        const result = missionStore.getMissionWithHierarchy(mission.id);
        res.status(201).json(result);
      } catch (err: any) {
        if (err.name === "SessionNotFoundError") {
          res.status(404).json({ error: err.message });
        } else {
          res.status(500).json({ error: err.message || "Failed to create mission" });
        }
      }
    })
  );

  return router;
}
