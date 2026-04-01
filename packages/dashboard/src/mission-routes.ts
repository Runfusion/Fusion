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
import type { TaskStore } from "@fusion/core";
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

// ── Param Utilities ────────────────────────────────────────────────────────

/** Extract a route param as string (Express 5 params can be string | string[]) */
function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

// ── Validation Utilities ────────────────────────────────────────────────────

function validateUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function validateMissionId(id: string | string[]): boolean {
  const str = Array.isArray(id) ? id[0] : id;
  return /^M-\d+$/.test(str);
}

function validateMilestoneId(id: string | string[]): boolean {
  const str = Array.isArray(id) ? id[0] : id;
  return /^MS-\d+$/.test(str);
}

function validateSliceId(id: string | string[]): boolean {
  const str = Array.isArray(id) ? id[0] : id;
  return /^SL-\d+$/.test(str);
}

function validateFeatureId(id: string | string[]): boolean {
  const str = Array.isArray(id) ? id[0] : id;
  return /^F-\d+$/.test(str);
}

/** Helper to extract string from Express param (handles string | string[]) */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
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
  const missionStore = store.getMissionStore();

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
      const { title, description } = req.body;

      const validatedTitle = validateTitle(title);
      const validatedDescription = validateDescription(description);

      const input: MissionCreateInput = {
        title: validatedTitle,
        description: validatedDescription,
      };

      const mission = missionStore.createMission(input);
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
      const missionId = param(req, "missionId");

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
      const missionId = param(req, "missionId");
      const { title, description, status } = req.body;

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
      const missionId = param(req, "missionId");

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
      const missionId = param(req, "missionId");

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
      const missionId = param(req, "missionId");

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
      const missionId = param(req, "missionId");
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
      const missionId = param(req, "missionId");

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
      const missionId = param(req, "missionId");
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
      const missionId = param(req, "missionId");

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
      const milestoneId = param(req, "milestoneId");

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
      const milestoneId = param(req, "milestoneId");
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
      const milestoneId = param(req, "milestoneId");

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
      const milestoneId = param(req, "milestoneId");

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
      const milestoneId = param(req, "milestoneId");
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
      const milestoneId = param(req, "milestoneId");

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
      const milestoneId = param(req, "milestoneId");
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
      const milestoneId = param(req, "milestoneId");

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
      const sliceId = param(req, "sliceId");

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
      const sliceId = param(req, "sliceId");
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
      const sliceId = param(req, "sliceId");

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
      const sliceId = param(req, "sliceId");

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
      const sliceId = param(req, "sliceId");

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
      const sliceId = param(req, "sliceId");
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
      const featureId = param(req, "featureId");

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
      const featureId = param(req, "featureId");
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
      const featureId = param(req, "featureId");

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
      const featureId = param(req, "featureId");
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
      const featureId = param(req, "featureId");

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

  // ── Interview Endpoints ─────────────────────────────────────────────────────
  // Note: These are mounted at /api/missions/interview/* via the router

  /**
   * POST /api/missions/interview/start
   * Start a mission interview session
   */
  router.post(
    "/interview/start",
    asyncHandler(async (req, res) => {
      // Placeholder - will be implemented in Step 4
      res.status(501).json({ error: "Interview system not yet implemented" });
    })
  );

  /**
   * POST /api/missions/interview/respond
   * Submit response to interview question
   */
  router.post(
    "/interview/respond",
    asyncHandler(async (req, res) => {
      // Placeholder - will be implemented in Step 4
      res.status(501).json({ error: "Interview system not yet implemented" });
    })
  );

  /**
   * POST /api/missions/interview/cancel
   * Cancel interview session
   */
  router.post(
    "/interview/cancel",
    asyncHandler(async (req, res) => {
      // Placeholder - will be implemented in Step 4
      res.status(501).json({ error: "Interview system not yet implemented" });
    })
  );

  /**
   * GET /api/missions/interview/:sessionId/stream
   * SSE stream for interview updates
   */
  router.get(
    "/interview/:sessionId/stream",
    asyncHandler(async (req, res) => {
      // Placeholder - will be implemented in Step 4/5
      res.status(501).json({ error: "Interview streaming not yet implemented" });
    })
  );

  /**
   * POST /api/missions/interview/create-mission
   * Create mission from completed interview
   */
  router.post(
    "/interview/create-mission",
    asyncHandler(async (req, res) => {
      // Placeholder - will be implemented in Step 4
      res.status(501).json({ error: "Interview system not yet implemented" });
    })
  );

  return router;
}
