/**
 * Goals REST API Routes
 *
 * Endpoints:
 * - GET / -> list goals (`?status=active|archived` optional)
 * - POST / -> create goal
 * - PATCH /:id -> update goal title/description
 * - POST /:id/archive -> archive goal (idempotent)
 * - POST /:id/unarchive -> unarchive goal
 *
 * Cap violations from create/unarchive return HTTP 409 with details:
 * `{ code: "ACTIVE_GOAL_LIMIT_EXCEEDED", limit, currentActive }`.
 */

import { Router, type Request, type Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Goal, GoalStatus, GoalUpdateInput, Mission, TaskStore } from "@fusion/core";
import { ApiError, badRequest, catchHandler, conflict, internalError, notFound } from "./api-error.js";
import { getOrCreateProjectStore } from "./project-store-resolver.js";

type GoalStoreLike = {
  listGoals(filter?: { status?: GoalStatus }): Goal[];
  createGoal(input: { title: string; description?: string }): Goal;
  getGoal(id: string): Goal | null;
  updateGoal(id: string, input: GoalUpdateInput): Goal;
  archiveGoal(id: string): Goal;
  unarchiveGoal(id: string): Goal;
};

type MissionStoreLike = {
  listMissionIdsForGoal(goalId: string): string[];
  getMission(missionId: string): Mission | null | undefined;
};

const GOAL_ID_RE = /^G-[A-Z0-9]+(?:-[A-Z0-9]+)*$/i;
const GOAL_STATUSES: GoalStatus[] = ["active", "archived"];

function getProjectIdFromRequest(req: Request): string | undefined {
  if (typeof req.query.projectId === "string" && req.query.projectId.trim()) {
    return req.query.projectId;
  }
  if (req.body && typeof req.body === "object" && typeof req.body.projectId === "string" && req.body.projectId.trim()) {
    return req.body.projectId;
  }
  return undefined;
}

function getGoalStore(store: TaskStore): GoalStoreLike {
  return store.getGoalStore();
}

function getMissionStore(store: TaskStore): MissionStoreLike {
  return store.getMissionStore();
}

function validateGoalId(id: unknown): string {
  if (typeof id !== "string" || !GOAL_ID_RE.test(id)) {
    throw badRequest("Invalid goal id format");
  }
  return id;
}

function validateTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim()) {
    throw badRequest("title is required");
  }
  if (title.length > 200) {
    throw badRequest("title must not exceed 200 characters");
  }
  return title.trim();
}

function validateDescription(description: unknown): string | undefined {
  if (description === undefined) return undefined;
  if (typeof description !== "string") {
    throw badRequest("description must be a string");
  }
  if (description.length > 5000) {
    throw badRequest("description must not exceed 5000 characters");
  }
  const trimmed = description.trim();
  return trimmed || undefined;
}

function rethrowGoalCapError(error: unknown): never {
  if (error instanceof ApiError) {
    throw error;
  }

  if (error && typeof error === "object" && "code" in error) {
    const typed = error as Record<string, unknown>;
    if (typed.code === "ACTIVE_GOAL_LIMIT_EXCEEDED") {
      const limit = typeof typed.limit === "number" ? typed.limit : 5;
      const currentActive = typeof typed.currentActive === "number" ? typed.currentActive : limit;
      throw conflict("Active goal limit exceeded", {
        code: "ACTIVE_GOAL_LIMIT_EXCEEDED",
        limit,
        currentActive,
      });
    }
  }

  if (error instanceof Error) {
    throw internalError(error.message);
  }

  throw internalError("Internal server error");
}

export function createGoalsRouter(store: TaskStore): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<TaskStore>();

  function getScopedStore(): TaskStore {
    return requestContext.getStore() ?? store;
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

  router.get(
    "/",
    catchHandler((req, res) => {
      const rawStatus = req.query.status;
      if (rawStatus !== undefined && rawStatus !== null) {
        if (typeof rawStatus !== "string" || !GOAL_STATUSES.includes(rawStatus as GoalStatus)) {
          throw badRequest("status must be one of: active, archived");
        }
      }

      const goalStore = getGoalStore(getScopedStore());
      const goals = goalStore.listGoals(rawStatus ? { status: rawStatus as GoalStatus } : undefined);
      res.json({ goals });
    }),
  );

  /**
   * FNXC:Goals 2026-06-15-14:45:
   * Goals view needs the reverse side of mission-goal links so each goal card can show and edit its missions without loading the full mission hierarchy.
   * Resolve the store's ordered link rows to current missions and skip missing mission records so stale links do not break the dashboard.
   */
  router.get(
    "/:id/missions",
    catchHandler((req, res) => {
      const id = validateGoalId(req.params.id);
      const scopedStore = getScopedStore();
      const goalStore = getGoalStore(scopedStore);
      if (!goalStore.getGoal(id)) {
        throw notFound(`Goal ${id} not found`);
      }

      const missionStore = getMissionStore(scopedStore);
      const missions = missionStore
        .listMissionIdsForGoal(id)
        .map((missionId) => missionStore.getMission(missionId))
        .filter((mission): mission is Mission => Boolean(mission))
        .map((mission) => ({ id: mission.id, title: mission.title, status: mission.status }));

      res.json({ missions });
    }),
  );

  router.post(
    "/",
    catchHandler((req, res) => {
      try {
        const input = req.body as { title?: unknown; description?: unknown };
        const goalStore = getGoalStore(getScopedStore());
        const goal = goalStore.createGoal({
          title: validateTitle(input.title),
          description: validateDescription(input.description),
        });
        res.status(201).json(goal);
      } catch (error) {
        rethrowGoalCapError(error);
      }
    }),
  );

  router.patch(
    "/:id",
    catchHandler((req, res) => {
      const id = validateGoalId(req.params.id);
      const input = req.body as { title?: unknown; description?: unknown };
      const updates: GoalUpdateInput = {};
      if (input.title !== undefined) {
        updates.title = validateTitle(input.title);
      }
      if (input.description !== undefined) {
        updates.description = validateDescription(input.description);
      }
      if (updates.title === undefined && updates.description === undefined) {
        throw badRequest("At least one field must be provided");
      }

      const goalStore = getGoalStore(getScopedStore());
      if (!goalStore.getGoal(id)) {
        throw notFound(`Goal ${id} not found`);
      }
      const updated = goalStore.updateGoal(id, updates);
      res.json(updated);
    }),
  );

  router.post(
    "/:id/archive",
    catchHandler((req, res) => {
      const id = validateGoalId(req.params.id);
      const goalStore = getGoalStore(getScopedStore());
      if (!goalStore.getGoal(id)) {
        throw notFound(`Goal ${id} not found`);
      }
      const archived = goalStore.archiveGoal(id);
      res.json(archived);
    }),
  );

  router.post(
    "/:id/unarchive",
    catchHandler((req, res) => {
      const id = validateGoalId(req.params.id);
      const goalStore = getGoalStore(getScopedStore());
      if (!goalStore.getGoal(id)) {
        throw notFound(`Goal ${id} not found`);
      }

      try {
        const unarchived = goalStore.unarchiveGoal(id);
        res.json(unarchived);
      } catch (error) {
        rethrowGoalCapError(error);
      }
    }),
  );

  return router;
}
