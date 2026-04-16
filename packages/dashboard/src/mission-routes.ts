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
  MissionAssertionStatus,
  FeatureLoopState,
  ContractAssertionCreateInput,
  ContractAssertionUpdateInput,
} from "@fusion/core";
import {
  MISSION_STATUSES,
  MILESTONE_STATUSES,
  SLICE_STATUSES,
  FEATURE_STATUSES,
  INTERVIEW_STATES,
  MISSION_ASSERTION_STATUSES,
} from "@fusion/core";
import { writeSSEEvent } from "./sse-buffer.js";
import {
  ApiError,
  badRequest,
  catchHandler,
  conflict,
  internalError,
  notFound,
  rateLimited,
} from "./api-error.js";
import type { AiSessionStore } from "./ai-session-store.js";

// ── Validation Utilities ────────────────────────────────────────────────────

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

function validateAssertionId(id: string): boolean {
  // Assertion IDs follow format: CA-{base36timestamp}-{random}
  // e.g., CA-A3B7CD-E9F2
  return /^CA-[A-Z0-9]+-[A-Z0-9]+$/i.test(id);
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

type TypedRequest = Request<Record<string, string>>;

function catchTypedHandler(fn: (req: TypedRequest, res: Response, next: NextFunction) => Promise<void>) {
  return catchHandler((req, res, next) => fn(req as TypedRequest, res, next));
}

// ── Router Factory ──────────────────────────────────────────────────────────

function parseLastEventId(req: Request): number | undefined {
  const rawHeader = req.headers["last-event-id"];
  const rawQuery = req.query.lastEventId;

  const raw = Array.isArray(rawHeader)
    ? rawHeader[0]
    : (typeof rawHeader === "string" ? rawHeader : Array.isArray(rawQuery) ? rawQuery[0] : rawQuery);

  if (raw === undefined || raw === null) return undefined;

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return parsed;
}

function replayBufferedSSE(
  res: Response,
  bufferedEvents: Array<{ id: number; event: string; data: string }>,
): boolean {
  for (const bufferedEvent of bufferedEvents) {
    if (!writeSSEEvent(res, bufferedEvent.event, bufferedEvent.data, bufferedEvent.id)) {
      return false;
    }
  }
  return true;
}

function checkSessionLock(
  sessionId: string,
  tabId: string | undefined,
  store: AiSessionStore | undefined,
): { allowed: true } | { allowed: false; currentHolder: string | null } {
  if (!tabId || !store) {
    return { allowed: true };
  }

  const result = store.acquireLock(sessionId, tabId);
  if (result.acquired) {
    return { allowed: true };
  }

  return { allowed: false, currentHolder: result.currentHolder };
}

export function createMissionRouter(
  store: TaskStore,
  missionAutopilot?: {
    watchMission(missionId: string): void;
    unwatchMission(missionId: string): void;
    isWatching(missionId: string): boolean;
    getAutopilotStatus(missionId: string): import("@fusion/core").AutopilotStatus;
    checkAndStartMission(missionId: string): Promise<void>;
    recoverStaleMission(missionId: string): Promise<void>;
    start(): void;
    stop(): void;
  },
  aiSessionStore?: AiSessionStore,
  missionExecutionLoop?: {
    recoverActiveMissions(): Promise<{ recoveredCount: number }>;
    isRunning(): boolean;
  },
  engineManager?: import("@fusion/engine").ProjectEngineManager,
): Router {
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
   * List all missions ordered by createdAt desc, with status summary
   * Uses batched query for optimal performance.
   */
  router.get(
    "/",
    catchTypedHandler(async (_req, res) => {
      const missionsWithSummary = missionStore.listMissionsWithSummaries();
      res.json(missionsWithSummary);
    })
  );

  /**
   * GET /api/missions/health
   * Get health metrics for all missions in a single batched request.
   * Returns a map of mission ID → health object.
   */
  router.get(
    "/health",
    catchTypedHandler(async (_req, res) => {
      const healthMap = missionStore.listMissionsHealth();
      // Convert Map to Record for JSON serialization
      const result: Record<string, ReturnType<typeof healthMap.get>> = {};
      for (const [missionId, health] of healthMap) {
        result[missionId] = health;
      }
      res.json(result);
    })
  );

  /**
   * POST /api/missions
   * Create a new mission
   */
  router.post(
    "/",
    catchTypedHandler(async (req, res) => {
      const { title, description, autoAdvance, autopilotEnabled } = req.body;

      const validatedTitle = validateTitle(title);
      const validatedDescription = validateDescription(description);

      const input: MissionCreateInput = {
        title: validatedTitle,
        description: validatedDescription,
      };

      const mission = missionStore.createMission(input);

      const updates: Partial<Mission> = {};
      if (autoAdvance !== undefined) {
        updates.autoAdvance = validateBoolean(autoAdvance, "autoAdvance");
      }
      if (autopilotEnabled !== undefined) {
        updates.autopilotEnabled = validateBoolean(autopilotEnabled, "autopilotEnabled");
      }

      if (Object.keys(updates).length > 0) {
        const updatedMission = missionStore.updateMission(mission.id, updates);
        res.status(201).json(updatedMission);
        return;
      }

      res.status(201).json(mission);
    })
  );

  // ── Interview Endpoints ─────────────────────────────────────────────────────
  // Note: These are mounted at /api/missions/interview/* via the router
  //
  // UTILITY PATH: All interview routes (mission, milestone, slice) are on a separate
  // control-plane lane. They must NOT be gated on task-lane saturation (maxConcurrent,
  // semaphore, queue depth). Session-lock 409 with { error, lockedByTab } is preserved.

  /**
   * Helper to resolve rootDir for the current request's project scope.
   */
  async function getRootDirForRequest(req: Request): Promise<string> {
    const projectId = getProjectIdFromRequest(req);
    const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : store;
    return scopedStore.getRootDir();
  }

  /**
   * Helper to resolve scoped store for the current request's project scope.
   */
  async function getScopedStoreForRequest(req: Request) {
    const projectId = getProjectIdFromRequest(req);
    return projectId ? await getOrCreateProjectStore(projectId) : store;
  }

  /**
   * Helper to resolve project context for the current request.
   * When engineManager is available and the request targets a known project,
   * returns the engine's TaskStore so callers share the same in-memory state.
   */
  async function getProjectContext(req: Request) {
    const projectId = getProjectIdFromRequest(req);
    if (projectId && engineManager) {
      const engine = engineManager.getEngine(projectId);
      if (engine) {
        return { store: engine.getTaskStore(), engine, projectId };
      }
    }
    const scopedStore = await getScopedStoreForRequest(req);
    return { store: scopedStore, engine: undefined, projectId };
  }

  /**
   * POST /api/missions/interview/start
   * Start a mission interview session with AI agent streaming.
   * Body: { missionTitle: string, modelProvider?: string, modelId?: string }
   * Returns: { sessionId: string }
   *
   * UTILITY PATH: Independent of task-lane saturation.
   */
  router.post(
    "/interview/start",
    catchTypedHandler(async (req, res) => {
      const { missionTitle, modelProvider, modelId } = req.body;

      if (!missionTitle || typeof missionTitle !== "string" || !missionTitle.trim()) {
        throw badRequest("missionTitle is required and must be a non-empty string");
      }

      if (missionTitle.length > 500) {
        throw badRequest("missionTitle must be 500 characters or less");
      }

      // Validate model parameters - if one is provided, both must be provided
      if (modelProvider !== undefined && typeof modelProvider !== "string") {
        throw badRequest("modelProvider must be a string when provided");
      }

      if (modelId !== undefined && typeof modelId !== "string") {
        throw badRequest("modelId must be a string when provided");
      }

      if ((modelProvider && !modelId) || (!modelProvider && modelId)) {
        throw badRequest("Both modelProvider and modelId must be provided together, or neither should be provided");
      }

      try {
        const ip = req.ip || req.socket.remoteAddress || "unknown";
        const { store: scopedStore } = await getProjectContext(req);
        const rootDir = scopedStore.getRootDir();
        const settings = await scopedStore.getSettings();

        const { createMissionInterviewSession } = await import("./mission-interview.js");

        const sessionId = await createMissionInterviewSession(
          ip,
          missionTitle.trim(),
          rootDir,
          settings.promptOverrides,
          modelProvider,
          modelId,
        );
        res.status(201).json({ sessionId });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === "RateLimitError") {
          throw rateLimited(errMsg);
        } else {
          throw internalError(errMsg || "Failed to start interview session");
        }
      }
    })
  );

  /**
   * POST /api/missions/interview/respond
   * Submit response to interview question.
   * Body: { sessionId: string, responses: Record<string, unknown> }
   *
   * UTILITY PATH: Independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post(
    "/interview/respond",
    catchTypedHandler(async (req, res) => {
      const { sessionId, responses, tabId } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!responses || typeof responses !== "object") {
        throw badRequest("responses is required and must be an object");
      }

      const normalizedTabId = typeof tabId === "string" && tabId.trim().length > 0 ? tabId.trim() : undefined;
      const lockCheck = checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      try {
        const { store: scopedStore } = await getProjectContext(req);
        const rootDir = scopedStore.getRootDir();
        const settings = await scopedStore.getSettings();

        const { submitMissionInterviewResponse } = await import("./mission-interview.js");

        const result = await submitMissionInterviewResponse(
          sessionId,
          responses,
          rootDir,
          settings.promptOverrides,
        );
        res.json(result);
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "SessionNotFoundError") {
          throw notFound(errMsg);
        } else if (errName === "InvalidSessionStateError") {
          throw badRequest(errMsg);
        } else {
          throw internalError(errMsg || "Failed to process response");
        }
      }
    })
  );

  /**
   * POST /api/missions/interview/:sessionId/retry
   * Retry a failed interview session by replaying the last user interaction.
   *
   * UTILITY PATH: Independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post(
    "/interview/:sessionId/retry",
    catchTypedHandler(async (req, res) => {
      const { sessionId } = req.params;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const tabId = typeof req.body?.tabId === "string" && req.body.tabId.trim().length > 0
        ? req.body.tabId.trim()
        : undefined;
      const lockCheck = checkSessionLock(sessionId, tabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      try {
        const { store: scopedStore } = await getProjectContext(req);
        const rootDir = scopedStore.getRootDir();
        const settings = await scopedStore.getSettings();

        const { retryMissionInterviewSession } = await import("./mission-interview.js");

        await retryMissionInterviewSession(sessionId, rootDir, settings.promptOverrides);
        res.json({ success: true, sessionId });
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "SessionNotFoundError") {
          throw notFound(errMsg);
        } else if (errName === "InvalidSessionStateError") {
          throw badRequest(errMsg);
        } else {
          throw internalError(errMsg || "Failed to retry interview session");
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
    catchTypedHandler(async (req, res) => {
      const { sessionId, tabId } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const normalizedTabId = typeof tabId === "string" && tabId.trim().length > 0 ? tabId.trim() : undefined;
      const lockCheck = checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      try {
        const { cancelMissionInterviewSession } = await import("./mission-interview.js");

        await cancelMissionInterviewSession(sessionId);
        res.json({ success: true });
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "SessionNotFoundError") {
          throw notFound(errMsg);
        } else {
          throw internalError(errMsg || "Failed to cancel session");
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
    catchTypedHandler(async (req, res) => {
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
          writeSSEEvent(res, "error", JSON.stringify({ message: "Session not found or expired" }));
          res.end();
          return;
        }

        const lastEventId = parseLastEventId(req);
        if (lastEventId !== undefined) {
          const buffered = missionInterviewStreamManager.getBufferedEvents(sessionId, lastEventId);
          if (!replayBufferedSSE(res, buffered)) {
            res.end();
            return;
          }
        }

        if (session.summary) {
          const existing = missionInterviewStreamManager.getBufferedEvents(sessionId, 0);
          const lastSummaryEvent = [...existing].reverse().find((event) => event.event === "summary");
          const summaryEventId = lastSummaryEvent?.id
            ?? missionInterviewStreamManager.broadcast(sessionId, {
              type: "summary",
              data: session.summary,
            });

          if (lastEventId === undefined || summaryEventId > lastEventId) {
            if (!writeSSEEvent(res, "summary", JSON.stringify(session.summary), summaryEventId)) {
              res.end();
              return;
            }
          }

          const lastCompleteEvent = [...existing].reverse().find((event) => event.event === "complete");
          const completeEventId = lastCompleteEvent?.id
            ?? missionInterviewStreamManager.broadcast(sessionId, { type: "complete" });

          if (lastEventId === undefined || completeEventId > lastEventId) {
            writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
          }

          res.end();
          return;
        }

        // Subscribe to session events
        const unsubscribe = missionInterviewStreamManager.subscribe(sessionId, (event, eventId) => {
          const data = (event as { data?: unknown }).data;
          if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
            unsubscribe();
            return;
          }

          // End stream on complete or error
          if (event.type === "complete" || event.type === "error") {
            unsubscribe();
            res.end();
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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeSSEEvent(res, "error", JSON.stringify({ message: errMsg || "Stream error" }));
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
    catchTypedHandler(async (req, res) => {
      const { sessionId, summary: editedSummary } = req.body;

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      try {
        const {
          getMissionInterviewSession,
          getMissionInterviewSummary,
          cleanupMissionInterviewSession,
        } = await import("./mission-interview.js");

        const session = getMissionInterviewSession(sessionId);
        if (!session) {
          throw notFound(`Interview session ${sessionId} not found or expired`);
        }

        // Use edited summary if provided, otherwise use the session's generated summary
        const summary = editedSummary || getMissionInterviewSummary(sessionId);
        if (!summary || !Array.isArray(summary.milestones)) {
          throw badRequest("Interview session is not complete or summary is missing");
        }

        // Create the full mission hierarchy
        const mission = missionStore.createMission({
          title: summary.missionTitle || session.missionTitle,
          description: summary.missionDescription,
        });

        // Update interview state to completed
        missionStore.updateMission(mission.id, { interviewState: "completed" as InterviewState });

        // Create milestones, slices, and features with verification in dedicated fields.
        // Auto-generate contract assertions for milestone, slice, and feature levels.
        for (const milestoneData of (summary.milestones ?? [])) {
          // Use dedicated verification field instead of concatenating into description
          const milestone = missionStore.addMilestone(mission.id, {
            title: milestoneData.title,
            description: milestoneData.description || undefined,
            verification: milestoneData.verification,
          });

          // Milestone-level assertion remains on the milestone even when it has no slices.
          missionStore.addContractAssertion(milestone.id, {
            title: `Milestone: ${milestoneData.title}`,
            assertion:
              milestoneData.verification
              || milestoneData.description
              || `Verify milestone completion: ${milestoneData.title}`,
            status: "pending",
          });

          for (const sliceData of (milestoneData.slices ?? [])) {
            // Use dedicated verification field instead of concatenating into description
            const slice = missionStore.addSlice(milestone.id, {
              title: sliceData.title,
              description: sliceData.description || undefined,
              verification: sliceData.verification,
            });

            // Slice-level assertion for explicit verification criteria.
            missionStore.addContractAssertion(milestone.id, {
              title: `Slice: ${sliceData.title}`,
              assertion:
                sliceData.verification
                || sliceData.description
                || `Verify slice completion: ${sliceData.title}`,
              status: "pending",
            });

            for (const featureData of (sliceData.features ?? [])) {
              const feature = missionStore.addFeature(slice.id, {
                title: featureData.title,
                description: featureData.description,
                acceptanceCriteria: featureData.acceptanceCriteria,
              });

              // Feature assertion text source priority: acceptanceCriteria -> description -> fallback
              const assertionText = featureData.acceptanceCriteria
                || featureData.description
                || `Verify implementation of: ${featureData.title}`;

              const assertion = missionStore.addContractAssertion(milestone.id, {
                title: featureData.title,
                assertion: assertionText,
                status: "pending",
              });

              // Link the assertion to the feature
              missionStore.linkFeatureToAssertion(feature.id, assertion.id);
            }
          }
        }

        // Cleanup the interview session
        cleanupMissionInterviewSession(sessionId);

        // Return the full hierarchy
        const result = missionStore.getMissionWithHierarchy(mission.id);
        res.status(201).json(result);
      } catch (err: unknown) {
        // Re-throw ApiError subclasses without wrapping
        if (err instanceof ApiError) {
          throw err;
        }
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "SessionNotFoundError") {
          throw notFound(errMsg);
        } else {
          throw internalError(errMsg || "Failed to create mission");
        }
      }
    })
  );

  /**
   * GET /api/missions/:missionId
   * Get mission by ID with full hierarchy
   */
  router.get(
    "/:missionId",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMissionWithHierarchy(missionId);
      if (!mission) {
        throw notFound("Mission not found");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;
      const { title, description, status, autoAdvance, autopilotEnabled } = req.body;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
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
      if (autopilotEnabled !== undefined) {
        updates.autopilotEnabled = validateBoolean(autopilotEnabled, "autopilotEnabled");
      }

      if (Object.keys(updates).length === 0) {
        throw badRequest("No valid fields to update");
      }

      try {
        const mission = missionStore.updateMission(missionId, updates);
        res.json(mission);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          throw notFound("Mission not found");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const existing = missionStore.getMission(missionId);
      if (!existing) {
        throw notFound("Mission not found");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const status = missionStore.computeMissionStatus(missionId);
      res.json({ status });
    })
  );

  /**
   * GET /api/missions/:missionId/events
   * Get paginated mission event log
   */
  router.get(
    "/:missionId/events",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const parseIntParam = (value: string | string[] | undefined, fallback: number): number => {
        if (typeof value !== "string") return fallback;
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
      };

      const limit = Math.min(parseIntParam(req.query.limit as string | string[] | undefined, 50), 200);
      const offset = parseIntParam(req.query.offset as string | string[] | undefined, 0);
      const eventType = typeof req.query.eventType === "string" && req.query.eventType.trim().length > 0
        ? req.query.eventType.trim()
        : undefined;

      const result = missionStore.getMissionEvents(missionId, {
        limit,
        offset,
        eventType,
      });

      res.json({
        events: result.events,
        total: result.total,
        limit,
        offset,
      });
    })
  );

  /**
   * GET /api/missions/:missionId/health
   * Get computed mission health metrics
   */
  router.get(
    "/:missionId/health",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const health = missionStore.getMissionHealth(missionId);
      if (!health) {
        throw notFound("Mission not found");
      }

      res.json(health);
    })
  );

  // ── Interview State Endpoints (Mission) ────────────────────────────────────

  /**
   * GET /api/missions/:missionId/interview-state
   * Get current interview state for mission
   */
  router.get(
    "/:missionId/interview-state",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;
      const { state } = req.body;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const validatedState = validateInterviewState(state);

      try {
        const mission = missionStore.updateMissionInterviewState(missionId, validatedState);
        res.json(mission);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          throw notFound("Mission not found");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;
      const { title, description, dependencies } = req.body;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const orderedIds = validateOrderedIds(req.body);

      // Validate all IDs belong to this mission
      const existingMilestones = missionStore.listMilestones(missionId);
      const existingIds = new Set(existingMilestones.map((m) => m.id));
      const allIdsValid = orderedIds.every((id) => existingIds.has(id));

      if (!allIdsValid) {
        throw badRequest("Invalid milestone IDs in orderedIds");
      }

      if (orderedIds.length !== existingIds.size) {
        throw badRequest("orderedIds must include all milestones");
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
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
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
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;
      const { title, description, status, dependencies } = req.body;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
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
        throw badRequest("No valid fields to update");
      }

      try {
        const milestone = missionStore.updateMilestone(milestoneId, updates);
        res.json(milestone);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          throw notFound("Milestone not found");
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
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const existing = missionStore.getMilestone(milestoneId);
      if (!existing) {
        throw notFound("Milestone not found");
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
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
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
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;
      const { state } = req.body;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const validatedState = validateInterviewState(state);

      try {
        const milestone = missionStore.updateMilestoneInterviewState(milestoneId, validatedState);
        res.json(milestone);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          throw notFound("Milestone not found");
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
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
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
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;
      const { title, description } = req.body;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
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
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
      }

      const orderedIds = validateOrderedIds(req.body);

      // Validate all IDs belong to this milestone
      const existingSlices = missionStore.listSlices(milestoneId);
      const existingIds = new Set(existingSlices.map((s) => s.id));
      const allIdsValid = orderedIds.every((id) => existingIds.has(id));

      if (!allIdsValid) {
        throw badRequest("Invalid slice IDs in orderedIds");
      }

      if (orderedIds.length !== existingIds.size) {
        throw badRequest("orderedIds must include all slices");
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
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        throw notFound("Slice not found");
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
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;
      const { title, description, status } = req.body;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
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
        throw badRequest("No valid fields to update");
      }

      try {
        const slice = missionStore.updateSlice(sliceId, updates);
        res.json(slice);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          throw notFound("Slice not found");
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
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      const existing = missionStore.getSlice(sliceId);
      if (!existing) {
        throw notFound("Slice not found");
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
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      try {
        const slice = await missionStore.activateSlice(sliceId);
        res.json(slice);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          throw notFound("Slice not found");
        }
        throw err;
      }
    })
  );

  // ── Assertion Endpoints ────────────────────────────────────────────────────

  /**
   * GET /api/missions/milestones/:milestoneId/assertions
   * List assertions for a milestone, ordered by orderIndex
   */
  router.get(
    "/milestones/:milestoneId/assertions",
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
      }

      const assertions = missionStore.listContractAssertions(milestoneId);
      res.json(assertions);
    })
  );

  /**
   * POST /api/missions/milestones/:milestoneId/assertions
   * Create a new assertion for a milestone
   */
  router.post(
    "/milestones/:milestoneId/assertions",
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;
      const { title, assertion: assertionText, status } = req.body;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
      }

      // Validate title
      if (!title || typeof title !== "string" || title.trim().length === 0) {
        throw badRequest("Title is required and must be a non-empty string");
      }
      if (title.length > 200) {
        throw badRequest("Title must not exceed 200 characters");
      }

      // Validate assertion text
      if (!assertionText || typeof assertionText !== "string" || assertionText.trim().length === 0) {
        throw badRequest("Assertion text is required and must be a non-empty string");
      }

      // Validate status if provided
      if (status !== undefined) {
        if (typeof status !== "string" || !MISSION_ASSERTION_STATUSES.includes(status as MissionAssertionStatus)) {
          throw badRequest(`Invalid status. Must be one of: ${MISSION_ASSERTION_STATUSES.join(", ")}`);
        }
      }

      const input: ContractAssertionCreateInput = {
        title: title.trim(),
        assertion: assertionText.trim(),
        status: status as MissionAssertionStatus,
      };

      const created = missionStore.addContractAssertion(milestoneId, input);
      res.status(201).json(created);
    })
  );

  /**
   * POST /api/missions/milestones/:milestoneId/assertions/reorder
   * Reorder assertions within a milestone
   */
  router.post(
    "/milestones/:milestoneId/assertions/reorder",
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
      }

      const orderedIds = validateOrderedIds(req.body);

      // Validate all IDs belong to this milestone
      const existingAssertions = missionStore.listContractAssertions(milestoneId);
      const existingIds = new Set(existingAssertions.map((a) => a.id));

      if (orderedIds.length !== existingIds.size) {
        throw badRequest("orderedIds must include all assertions");
      }

      for (const id of orderedIds) {
        if (!existingIds.has(id)) {
          throw badRequest(`Assertion ${id} does not belong to milestone ${milestoneId}`);
        }
      }

      missionStore.reorderContractAssertions(milestoneId, orderedIds);
      res.status(204).send();
    })
  );

  /**
   * GET /api/missions/assertions/:assertionId
   * Get a single assertion by ID
   */
  router.get(
    "/assertions/:assertionId",
    catchTypedHandler(async (req, res) => {
      const { assertionId } = req.params;

      if (!validateAssertionId(assertionId)) {
        throw badRequest("Invalid assertion ID format");
      }

      const assertion = missionStore.getContractAssertion(assertionId);
      if (!assertion) {
        throw notFound("Assertion not found");
      }

      res.json(assertion);
    })
  );

  /**
   * PATCH /api/missions/assertions/:assertionId
   * Update an assertion
   */
  router.patch(
    "/assertions/:assertionId",
    catchTypedHandler(async (req, res) => {
      const { assertionId } = req.params;
      const { title, assertion: assertionText, status } = req.body;

      if (!validateAssertionId(assertionId)) {
        throw badRequest("Invalid assertion ID format");
      }

      const existing = missionStore.getContractAssertion(assertionId);
      if (!existing) {
        throw notFound("Assertion not found");
      }

      // If body is empty object, reject
      if (Object.keys(req.body).length === 0) {
        throw badRequest("No valid fields to update");
      }

      const updates: ContractAssertionUpdateInput = {};

      if (title !== undefined) {
        if (typeof title !== "string" || title.trim().length === 0) {
          throw badRequest("Title must be a non-empty string");
        }
        if (title.length > 200) {
          throw badRequest("Title must not exceed 200 characters");
        }
        updates.title = title.trim();
      }

      if (assertionText !== undefined) {
        if (typeof assertionText !== "string" || assertionText.trim().length === 0) {
          throw badRequest("Assertion text must be a non-empty string");
        }
        updates.assertion = assertionText.trim();
      }

      if (status !== undefined) {
        if (typeof status !== "string" || !MISSION_ASSERTION_STATUSES.includes(status as MissionAssertionStatus)) {
          throw badRequest(`Invalid status. Must be one of: ${MISSION_ASSERTION_STATUSES.join(", ")}`);
        }
        updates.status = status as MissionAssertionStatus;
      }

      const updated = missionStore.updateContractAssertion(assertionId, updates);
      res.json(updated);
    })
  );

  /**
   * DELETE /api/missions/assertions/:assertionId
   * Delete an assertion
   */
  router.delete(
    "/assertions/:assertionId",
    catchTypedHandler(async (req, res) => {
      const { assertionId } = req.params;

      if (!validateAssertionId(assertionId)) {
        throw badRequest("Invalid assertion ID format");
      }

      const existing = missionStore.getContractAssertion(assertionId);
      if (!existing) {
        throw notFound("Assertion not found");
      }

      missionStore.deleteContractAssertion(assertionId);
      res.status(204).send();
    })
  );

  /**
   * POST /api/missions/features/:featureId/assertions/:assertionId/link
   * Link a feature to an assertion
   */
  router.post(
    "/features/:featureId/assertions/:assertionId/link",
    catchTypedHandler(async (req, res) => {
      const { featureId, assertionId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      if (!validateAssertionId(assertionId)) {
        throw badRequest("Invalid assertion ID format");
      }

      try {
        missionStore.linkFeatureToAssertion(featureId, assertionId);
        res.json({ success: true });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          if (errMsg.includes(`Feature ${featureId}`)) {
            throw notFound("Feature not found");
          }
          throw notFound("Assertion not found");
        }
        if (errMsg.includes("already linked")) {
          throw conflict(`Feature ${featureId} is already linked to assertion ${assertionId}`);
        }
        throw err;
      }
    })
  );

  /**
   * POST /api/missions/features/:featureId/assertions/:assertionId/unlink
   * Unlink a feature from an assertion
   */
  router.post(
    "/features/:featureId/assertions/:assertionId/unlink",
    catchTypedHandler(async (req, res) => {
      const { featureId, assertionId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      if (!validateAssertionId(assertionId)) {
        throw badRequest("Invalid assertion ID format");
      }

      try {
        missionStore.unlinkFeatureFromAssertion(featureId, assertionId);
        res.json({ success: true });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          if (errMsg.includes(`Feature ${featureId}`)) {
            throw notFound("Feature not found");
          }
          throw notFound("Assertion not found");
        }
        if (errMsg.includes("not linked")) {
          throw badRequest(`Feature ${featureId} is not linked to assertion ${assertionId}`);
        }
        throw err;
      }
    })
  );

  /**
   * GET /api/missions/features/:featureId/assertions
   * List assertions linked to a feature
   */
  router.get(
    "/features/:featureId/assertions",
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      const feature = missionStore.getFeature(featureId);
      if (!feature) {
        throw notFound("Feature not found");
      }

      const assertions = missionStore.listAssertionsForFeature(featureId);
      res.json(assertions);
    })
  );

  /**
   * GET /api/missions/assertions/:assertionId/features
   * List features linked to an assertion
   */
  router.get(
    "/assertions/:assertionId/features",
    catchTypedHandler(async (req, res) => {
      const { assertionId } = req.params;

      if (!validateAssertionId(assertionId)) {
        throw badRequest("Invalid assertion ID format");
      }

      const assertion = missionStore.getContractAssertion(assertionId);
      if (!assertion) {
        throw notFound("Assertion not found");
      }

      const features = missionStore.listFeaturesForAssertion(assertionId);
      res.json(features);
    })
  );

  /**
   * GET /api/missions/milestones/:milestoneId/validation
   * Get milestone validation rollup
   */
  router.get(
    "/milestones/:milestoneId/validation",
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
      }

      const rollup = missionStore.getMilestoneValidationRollup(milestoneId);
      res.json(rollup);
    })
  );

  // ── Validation & Loop State Endpoints ─────────────────────────────────────

  /**
   * POST /api/missions/features/:featureId/validate
   * Trigger validation for a feature. Starts a validator run and transitions
   * the feature to "validating" state. Returns run metadata.
   * 400 if no assertions are linked to the feature.
   * 404 if the feature does not exist.
   */
  router.post(
    "/features/:featureId/validate",
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      const feature = missionStore.getFeature(featureId);
      if (!feature) {
        throw notFound("Feature not found");
      }

      // Check if there are linked assertions
      const assertions = missionStore.listAssertionsForFeature(featureId);
      if (assertions.length === 0) {
        throw badRequest("Feature has no linked assertions. Link assertions before triggering validation.");
      }

      // Transition feature to validating state
      missionStore.updateFeature(featureId, {
        loopState: "validating" as FeatureLoopState,
      });

      // Start a validator run
      const run = missionStore.startValidatorRun(featureId, "manual");

      res.status(202).json({
        runId: run.id,
        featureId: run.featureId,
        status: run.status,
        triggerType: run.triggerType,
        implementationAttempt: run.implementationAttempt,
        validatorAttempt: run.validatorAttempt,
        startedAt: run.startedAt,
      });
    })
  );

  /**
   * GET /api/missions/features/:featureId/validation-loop
   * Get the current loop state snapshot for a feature.
   * Returns idle state when no loop is active.
   * 404 if the feature does not exist.
   */
  router.get(
    "/features/:featureId/validation-loop",
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      const feature = missionStore.getFeature(featureId);
      if (!feature) {
        throw notFound("Feature not found");
      }

      const snapshot = missionStore.getFeatureLoopSnapshot(featureId);
      res.json(snapshot);
    })
  );

  /**
   * GET /api/missions/features/:featureId/validation-runs
   * List validator runs for a feature, ordered by startedAt DESC.
   * Supports pagination via limit and offset query parameters.
   * 404 if the feature does not exist.
   */
  router.get(
    "/features/:featureId/validation-runs",
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      const feature = missionStore.getFeature(featureId);
      if (!feature) {
        throw notFound("Feature not found");
      }

      // Parse pagination parameters
      const limit = typeof req.query.limit === "string"
        ? Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)
        : 20;
      const offset = typeof req.query.offset === "string"
        ? Math.max(parseInt(req.query.offset, 10) || 0, 0)
        : 0;

      // Get all runs (store returns them ordered DESC)
      const allRuns = missionStore.getValidatorRunsByFeature(featureId);
      const total = allRuns.length;
      const runs = allRuns.slice(offset, offset + limit);

      res.json({
        runs,
        total,
        limit,
        offset,
      });
    })
  );

  /**
   * GET /api/missions/validation-runs/:runId
   * Get a single validator run with assertion results.
   * 404 if the run does not exist.
   */
  router.get(
    "/validation-runs/:runId",
    catchTypedHandler(async (req, res) => {
      const { runId } = req.params;

      if (!runId || typeof runId !== "string") {
        throw badRequest("Run ID is required");
      }

      // Use the store's getValidatorRun method to fetch the run directly
      const run = missionStore.getValidatorRun(runId);
      if (!run) {
        throw notFound("Validator run not found");
      }

      // Get failures for this run
      const failures = missionStore.getFailuresForRun(runId);

      res.json({
        ...run,
        failures,
      });
    })
  );

  /**
   * POST /api/missions/recover
   * Trigger recovery of active missions. Re-enqueues validating and needs_fix
   * features for processing.
   * Returns summary of recovered features. Idempotent - second call returns <= first.
   */
  router.post(
    "/recover",
    catchTypedHandler(async (req, res) => {
      if (!missionExecutionLoop) {
        throw internalError("Mission execution loop is not available");
      }

      if (!missionExecutionLoop.isRunning()) {
        throw internalError("Mission execution loop is not running");
      }

      try {
        const result = await missionExecutionLoop.recoverActiveMissions();
        res.json({
          recoveredCount: result.recoveredCount,
          message: `Recovered ${result.recoveredCount} features`,
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw internalError(`Recovery failed: ${errMsg}`);
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
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        throw notFound("Slice not found");
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
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;
      const { title, description, acceptanceCriteria } = req.body;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        throw notFound("Slice not found");
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
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      const feature = missionStore.getFeature(featureId);
      if (!feature) {
        throw notFound("Feature not found");
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
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;
      const { title, description, acceptanceCriteria, status } = req.body;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      // Fetch existing feature to check invariants
      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        throw notFound("Feature not found");
      }

      // Guard: Reject status transitions to execution states without a linked task.
      // Features in "triaged", "in-progress", "done", or "blocked" must have a taskId.
      // "defined" status is allowed without a taskId (the initial state).
      if (status !== undefined) {
        const targetStatus = validateStatus(status, FEATURE_STATUSES) as FeatureStatus;
        const EXECUTION_STATUSES: FeatureStatus[] = ["triaged", "in-progress", "done", "blocked"];
        if (EXECUTION_STATUSES.includes(targetStatus) && !existing.taskId) {
          throw badRequest(
            `Cannot set status to '${targetStatus}' without a linked task. ` +
            "Use the triage endpoint to create and link a task first, or link an existing task via " +
            `POST /api/missions/features/${featureId}/link-task.`,
          );
        }
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
        throw badRequest("No valid fields to update");
      }

      try {
        const feature = missionStore.updateFeature(featureId, updates);
        res.json(feature);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found")) {
          throw notFound("Feature not found");
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
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        throw notFound("Feature not found");
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
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;
      const { taskId } = req.body;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      if (!taskId || typeof taskId !== "string") {
        throw badRequest("taskId is required and must be a string");
      }

      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        throw notFound("Feature not found");
      }

      try {
        const feature = missionStore.linkFeatureToTask(featureId, taskId);
        res.json(feature);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("already linked")) {
          throw conflict(errMsg);
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
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        throw notFound("Feature not found");
      }

      if (!existing.taskId) {
        throw badRequest("Feature is not linked to a task");
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
    catchTypedHandler(async (req, res) => {
      const { featureId } = req.params;
      const { taskTitle, taskDescription } = req.body || {};

      if (!validateFeatureId(featureId)) {
        throw badRequest("Invalid feature ID format");
      }

      const existing = missionStore.getFeature(featureId);
      if (!existing) {
        throw notFound("Feature not found");
      }

      try {
        const feature = await missionStore.triageFeature(
          featureId,
          taskTitle || undefined,
          taskDescription || undefined,
        );
        res.json(feature);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("already")) {
          throw badRequest(errMsg);
        }
        if (errMsg.includes("TaskStore")) {
          throw new ApiError(503, "TaskStore not available for triage operations");
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
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        throw notFound("Slice not found");
      }

      try {
        const triaged = await missionStore.triageSlice(sliceId);
        res.json({ triaged, count: triaged.length });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("TaskStore")) {
          throw new ApiError(503, "TaskStore not available for triage operations");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      if (mission.status === "blocked") {
        throw badRequest("Mission is already paused (blocked)");
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
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      if (mission.status !== "blocked") {
        throw badRequest("Mission is not paused (status must be 'blocked' to resume)");
      }

      missionStore.updateMission(missionId, { status: "active" });

      // Re-engage autopilot if enabled and autopilot instance is available.
      // The autopilot may have been stopped or the mission unwatched during
      // the pause/stop lifecycle — re-register it and trigger progression.
      if (missionAutopilot && mission.autopilotEnabled) {
        missionAutopilot.watchMission(missionId);

        // Always call recoverStaleMission for resumed missions to reconcile
        // any inconsistent state (defined features without tasks, stale status, etc.)
        // and progress if possible.
        await missionAutopilot.recoverStaleMission(missionId);
      }

      const refreshed = missionStore.getMission(missionId);
      res.json(refreshed);
    })
  );

  /**
   * POST /api/missions/:missionId/stop
   * Stop a mission: set status to "blocked" and pause all linked tasks.
   */
  router.post(
    "/:missionId/stop",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const hierarchy = missionStore.getMissionWithHierarchy(missionId);
      if (!hierarchy) {
        throw notFound("Mission not found");
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
              } catch (_err) {
                // Log but don't fail — task may already be paused or not found
              }
            }
          }
        }
      }

      res.json({ ...updated, pausedTaskIds });
    })
  );

  // ── Mission Start Endpoint ────────────────────────────────────────────────────

  /**
   * POST /api/missions/:missionId/start
   * Start a planning mission: set status to "active", activate the first
   * pending slice, and auto-triage all "defined" features in that slice.
   */
  router.post(
    "/:missionId/start",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      if (mission.status !== "planning") {
        throw conflict("Mission must be in 'planning' status to start");
      }

      const nextSlice = missionStore.findNextPendingSlice(missionId);
      if (!nextSlice) {
        throw badRequest("No pending slices found");
      }

      // Enable autopilot (and autoAdvance for backward compat) so the mission
      // will auto-advance slices when autopilot is watching
      missionStore.updateMission(missionId, {
        autopilotEnabled: true,
        autoAdvance: true, // kept for backward compat with existing mission data
        status: "active",
      });

      // Activate the first pending slice (triggers auto-triage via activateSlice)
      await missionStore.activateSlice(nextSlice.id);

      // Return updated mission with hierarchy
      const hierarchy = missionStore.getMissionWithHierarchy(missionId);
      res.json(hierarchy);
    })
  );

  // ── Autopilot Endpoints ──────────────────────────────────────────────────────

  /**
   * GET /api/missions/:missionId/autopilot
   * Get the current autopilot status for a mission.
   * Returns { enabled, state, watched, lastActivityAt }
   */
  router.get(
    "/:missionId/autopilot",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      if (missionAutopilot) {
        const status = missionAutopilot.getAutopilotStatus(missionId);
        res.json(status);
      } else {
        // No autopilot instance — return status from mission data
        res.json({
          enabled: mission.autopilotEnabled ?? false,
          state: mission.autopilotState ?? "inactive",
          watched: false,
          lastActivityAt: mission.lastAutopilotActivityAt,
        });
      }
    })
  );

  /**
   * PATCH /api/missions/:missionId/autopilot
   * Enable or disable autopilot for a mission.
   * Body: { enabled?: boolean }
   * When enabling: starts watching if autopilot is available.
   * When disabling: stops watching if autopilot is available.
   */
  router.patch(
    "/:missionId/autopilot",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;
      const { enabled } = req.body;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      if (enabled === undefined || typeof enabled !== "boolean") {
        throw badRequest("enabled is required and must be a boolean");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      // Update the mission's autopilotEnabled field
      missionStore.updateMission(missionId, { autopilotEnabled: enabled });

      if (missionAutopilot) {
        if (enabled) {
          // Enable: start watching and potentially start/recover the mission
          missionAutopilot.watchMission(missionId);
          if (mission.status === "planning") {
            await missionAutopilot.checkAndStartMission(missionId);
          } else if (mission.status === "active") {
            // For already-active missions, call recoverStaleMission to reconcile
            // any inconsistent state (defined features without tasks, stale status, etc.)
            // and progress if possible.
            await missionAutopilot.recoverStaleMission(missionId);
          }
        } else {
          // Disable: stop watching
          missionAutopilot.unwatchMission(missionId);
        }

        const status = missionAutopilot.getAutopilotStatus(missionId);
        res.json(status);
      } else {
        // No autopilot instance — return updated status from mission data
        const updated = missionStore.getMission(missionId);
        res.json({
          enabled: updated?.autopilotEnabled ?? false,
          state: updated?.autopilotState ?? "inactive",
          watched: false,
          lastActivityAt: updated?.lastAutopilotActivityAt,
        });
      }
    })
  );

  /**
   * POST /api/missions/:missionId/autopilot/start
   * Manually start autopilot watching for a mission.
   */
  router.post(
    "/:missionId/autopilot/start",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      if (!mission.autopilotEnabled) {
        throw badRequest("Autopilot is not enabled for this mission");
      }

      if (!missionAutopilot) {
        throw new ApiError(503, "Autopilot service is not available");
      }

      missionAutopilot.watchMission(missionId);

      // If mission is in planning, start it. If already active, trigger recovery
      // to reconcile any inconsistent state and progress if possible.
      if (mission.status === "planning") {
        await missionAutopilot.checkAndStartMission(missionId);
      } else if (mission.status === "active") {
        await missionAutopilot.recoverStaleMission(missionId);
      }

      const status = missionAutopilot.getAutopilotStatus(missionId);
      res.json(status);
    })
  );

  /**
   * POST /api/missions/:missionId/autopilot/stop
   * Manually stop autopilot watching for a mission.
   */
  router.post(
    "/:missionId/autopilot/stop",
    catchTypedHandler(async (req, res) => {
      const { missionId } = req.params;

      if (!validateMissionId(missionId)) {
        throw badRequest("Invalid mission ID format");
      }

      const mission = missionStore.getMission(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      if (missionAutopilot) {
        missionAutopilot.unwatchMission(missionId);
        const status = missionAutopilot.getAutopilotStatus(missionId);
        res.json(status);
      } else {
        res.json({
          enabled: mission.autopilotEnabled ?? false,
          state: "inactive",
          watched: false,
          lastActivityAt: mission.lastAutopilotActivityAt,
        });
      }
    })
  );

  // ── Milestone Interview Routes ─────────────────────────────────────────────────
  // UTILITY PATH: Milestone interview routes are independent of task-lane saturation.

  /**
   * POST /milestones/:milestoneId/interview/start
   * Start a milestone interview session with AI agent streaming.
   * Returns: { sessionId: string }
   *
   * UTILITY PATH: Independent of task-lane saturation.
   */
  router.post(
    "/milestones/:milestoneId/interview/start",
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      const milestone = missionStore.getMilestone(milestoneId);
      if (!milestone) {
        throw notFound("Milestone not found");
      }

      try {
        const ip = req.ip || req.socket.remoteAddress || "unknown";
        const rootDir = await getRootDirForRequest(req);

        // Get mission context for the interview
        const mission = missionStore.getMission(milestone.missionId);
        const missionContext = mission
          ? `Mission: "${mission.title}". ${mission.description || ""}`
          : undefined;

        const { createTargetInterviewSession } = await import("./milestone-slice-interview.js");

        const sessionId = await createTargetInterviewSession(
          ip,
          "milestone",
          milestoneId,
          milestone.title,
          missionContext,
          rootDir
        );
        res.status(201).json({ sessionId });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === "RateLimitError") {
          throw rateLimited(errMsg);
        } else {
          throw internalError(errMsg || "Failed to start interview session");
        }
      }
    })
  );

  /**
   * POST /milestones/:milestoneId/interview/respond
   * Submit response to milestone interview question.
   * Body: { sessionId: string, responses: Record<string, unknown>, tabId?: string }
   *
   * UTILITY PATH: Independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post(
    "/milestones/:milestoneId/interview/respond",
    catchTypedHandler(async (req, res) => {
      const { sessionId, responses, tabId } = req.body;

      if (!validateMilestoneId(req.params.milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!responses || typeof responses !== "object") {
        throw badRequest("responses is required and must be an object");
      }

      const normalizedTabId = typeof tabId === "string" && tabId.trim().length > 0 ? tabId.trim() : undefined;
      const lockCheck = checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      try {
        const { submitTargetInterviewResponse } = await import("./milestone-slice-interview.js");

        const rootDir = await getRootDirForRequest(req);
        const result = await submitTargetInterviewResponse(sessionId, responses, rootDir);
        res.json(result);
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "TargetSessionNotFoundError") {
          throw notFound(errMsg);
        } else if (errName === "TargetInvalidSessionStateError") {
          throw badRequest(errMsg);
        } else {
          throw internalError(errMsg || "Failed to process response");
        }
      }
    })
  );

  /**
   * GET /milestones/:milestoneId/interview/:sessionId/stream
   * SSE endpoint for real-time milestone interview session updates.
   * Streams thinking output, questions, summaries, and errors.
   */
  router.get(
    "/milestones/:milestoneId/interview/:sessionId/stream",
    catchTypedHandler(async (req, res) => {
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
          milestoneSliceInterviewStreamManager: msStreamManager,
          getTargetInterviewSession,
        } = await import("./milestone-slice-interview.js");

        // Verify session exists
        const session = getTargetInterviewSession(sessionId);
        if (!session) {
          writeSSEEvent(res, "error", JSON.stringify({ message: "Session not found or expired" }));
          res.end();
          return;
        }

        const lastEventId = parseLastEventId(req);
        if (lastEventId !== undefined) {
          const buffered = msStreamManager.getBufferedEvents(sessionId, lastEventId);
          if (!replayBufferedSSE(res, buffered)) {
            res.end();
            return;
          }
        }

        if (session.summary) {
          const existing = msStreamManager.getBufferedEvents(sessionId, 0);
          const lastSummaryEvent = [...existing].reverse().find((event) => event.event === "summary");
          const summaryEventId = lastSummaryEvent?.id
            ?? msStreamManager.broadcast(sessionId, {
              type: "summary",
              data: session.summary,
            });

          if (lastEventId === undefined || summaryEventId > lastEventId) {
            if (!writeSSEEvent(res, "summary", JSON.stringify(session.summary), summaryEventId)) {
              res.end();
              return;
            }
          }

          const lastCompleteEvent = [...existing].reverse().find((event) => event.event === "complete");
          const completeEventId = lastCompleteEvent?.id
            ?? msStreamManager.broadcast(sessionId, { type: "complete" });

          if (lastEventId === undefined || completeEventId > lastEventId) {
            writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
          }

          res.end();
          return;
        }

        // Subscribe to session events
        const unsubscribe = msStreamManager.subscribe(sessionId, (event, eventId) => {
          const data = (event as { data?: unknown }).data;
          if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
            unsubscribe();
            return;
          }

          // End stream on complete or error
          if (event.type === "complete" || event.type === "error") {
            unsubscribe();
            res.end();
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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeSSEEvent(res, "error", JSON.stringify({ message: errMsg || "Stream error" }));
        res.end();
      }
    })
  );

  /**
   * POST /milestones/:milestoneId/interview/:sessionId/retry
   * Retry a failed milestone interview session.
   *
   * UTILITY PATH: Independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post(
    "/milestones/:milestoneId/interview/:sessionId/retry",
    catchTypedHandler(async (req, res) => {
      const { sessionId } = req.params;

      if (!validateMilestoneId(req.params.milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const tabId = typeof req.body?.tabId === "string" && req.body.tabId.trim().length > 0
        ? req.body.tabId.trim()
        : undefined;
      const lockCheck = checkSessionLock(sessionId, tabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      try {
        const { retryTargetInterviewSession } = await import("./milestone-slice-interview.js");

        const rootDir = await getRootDirForRequest(req);
        await retryTargetInterviewSession(sessionId, rootDir);
        res.json({ success: true, sessionId });
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "TargetSessionNotFoundError") {
          throw notFound(errMsg);
        } else if (errName === "TargetInvalidSessionStateError") {
          throw badRequest(errMsg);
        } else {
          throw internalError(errMsg || "Failed to retry interview session");
        }
      }
    })
  );

  /**
   * POST /milestones/:milestoneId/interview/apply
   * Apply milestone interview summary to the milestone.
   * Body: { sessionId: string, summary?: TargetInterviewSummary }
   */
  router.post(
    "/milestones/:milestoneId/interview/apply",
    catchTypedHandler(async (req, res) => {
      const { sessionId } = req.body;

      if (!validateMilestoneId(req.params.milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      try {
        const { applyTargetInterview } = await import("./milestone-slice-interview.js");

        const milestone = applyTargetInterview(sessionId, missionStore);
        res.json(milestone);
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "TargetSessionNotFoundError") {
          throw notFound(errMsg);
        } else {
          throw internalError(errMsg || "Failed to apply interview");
        }
      }
    })
  );

  /**
   * POST /milestones/:milestoneId/interview/skip
   * Skip milestone interview and apply mission-level context.
   */
  router.post(
    "/milestones/:milestoneId/interview/skip",
    catchTypedHandler(async (req, res) => {
      const { milestoneId } = req.params;

      if (!validateMilestoneId(milestoneId)) {
        throw badRequest("Invalid milestone ID format");
      }

      try {
        const {
          skipTargetInterview,
        } = await import("./milestone-slice-interview.js");

        const milestone = skipTargetInterview("milestone", milestoneId, missionStore);
        res.json(milestone);
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "TargetSessionNotFoundError") {
          throw notFound(errMsg);
        } else {
          throw internalError(errMsg || "Failed to skip interview");
        }
      }
    })
  );

  // ── Slice Interview Routes ─────────────────────────────────────────────────
  // UTILITY PATH: Slice interview routes are independent of task-lane saturation.

  /**
   * POST /slices/:sliceId/interview/start
   * Start a slice interview session with AI agent streaming.
   * Returns: { sessionId: string }
   *
   * UTILITY PATH: Independent of task-lane saturation.
   */
  router.post(
    "/slices/:sliceId/interview/start",
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      const slice = missionStore.getSlice(sliceId);
      if (!slice) {
        throw notFound("Slice not found");
      }

      try {
        const ip = req.ip || req.socket.remoteAddress || "unknown";
        const rootDir = await getRootDirForRequest(req);

        // Get mission hierarchy context for the interview
        const milestone = missionStore.getMilestone(slice.milestoneId);
        const mission = milestone ? missionStore.getMission(milestone.missionId) : undefined;
        const missionContext = mission && milestone
          ? `Mission: "${mission.title}". Milestone: "${milestone.title}". ${mission.description || ""}`
          : milestone
            ? `Milestone: "${milestone.title}".`
            : undefined;

        const { createTargetInterviewSession } = await import("./milestone-slice-interview.js");

        const sessionId = await createTargetInterviewSession(
          ip,
          "slice",
          sliceId,
          slice.title,
          missionContext,
          rootDir
        );
        res.status(201).json({ sessionId });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === "RateLimitError") {
          throw rateLimited(errMsg);
        } else {
          throw internalError(errMsg || "Failed to start interview session");
        }
      }
    })
  );

  /**
   * POST /slices/:sliceId/interview/respond
   * Submit response to slice interview question.
   * Body: { sessionId: string, responses: Record<string, unknown>, tabId?: string }
   *
   * UTILITY PATH: Independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post(
    "/slices/:sliceId/interview/respond",
    catchTypedHandler(async (req, res) => {
      const { sessionId, responses, tabId } = req.body;

      if (!validateSliceId(req.params.sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!responses || typeof responses !== "object") {
        throw badRequest("responses is required and must be an object");
      }

      const normalizedTabId = typeof tabId === "string" && tabId.trim().length > 0 ? tabId.trim() : undefined;
      const lockCheck = checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      try {
        const { submitTargetInterviewResponse } = await import("./milestone-slice-interview.js");

        const rootDir = await getRootDirForRequest(req);
        const result = await submitTargetInterviewResponse(sessionId, responses, rootDir);
        res.json(result);
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "TargetSessionNotFoundError") {
          throw notFound(errMsg);
        } else if (errName === "TargetInvalidSessionStateError") {
          throw badRequest(errMsg);
        } else {
          throw internalError(errMsg || "Failed to process response");
        }
      }
    })
  );

  /**
   * GET /slices/:sliceId/interview/:sessionId/stream
   * SSE endpoint for real-time slice interview session updates.
   * Streams thinking output, questions, summaries, and errors.
   */
  router.get(
    "/slices/:sliceId/interview/:sessionId/stream",
    catchTypedHandler(async (req, res) => {
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
          milestoneSliceInterviewStreamManager: msStreamManager,
          getTargetInterviewSession,
        } = await import("./milestone-slice-interview.js");

        // Verify session exists
        const session = getTargetInterviewSession(sessionId);
        if (!session) {
          writeSSEEvent(res, "error", JSON.stringify({ message: "Session not found or expired" }));
          res.end();
          return;
        }

        const lastEventId = parseLastEventId(req);
        if (lastEventId !== undefined) {
          const buffered = msStreamManager.getBufferedEvents(sessionId, lastEventId);
          if (!replayBufferedSSE(res, buffered)) {
            res.end();
            return;
          }
        }

        if (session.summary) {
          const existing = msStreamManager.getBufferedEvents(sessionId, 0);
          const lastSummaryEvent = [...existing].reverse().find((event) => event.event === "summary");
          const summaryEventId = lastSummaryEvent?.id
            ?? msStreamManager.broadcast(sessionId, {
              type: "summary",
              data: session.summary,
            });

          if (lastEventId === undefined || summaryEventId > lastEventId) {
            if (!writeSSEEvent(res, "summary", JSON.stringify(session.summary), summaryEventId)) {
              res.end();
              return;
            }
          }

          const lastCompleteEvent = [...existing].reverse().find((event) => event.event === "complete");
          const completeEventId = lastCompleteEvent?.id
            ?? msStreamManager.broadcast(sessionId, { type: "complete" });

          if (lastEventId === undefined || completeEventId > lastEventId) {
            writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
          }

          res.end();
          return;
        }

        // Subscribe to session events
        const unsubscribe = msStreamManager.subscribe(sessionId, (event, eventId) => {
          const data = (event as { data?: unknown }).data;
          if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
            unsubscribe();
            return;
          }

          // End stream on complete or error
          if (event.type === "complete" || event.type === "error") {
            unsubscribe();
            res.end();
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
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeSSEEvent(res, "error", JSON.stringify({ message: errMsg || "Stream error" }));
        res.end();
      }
    })
  );

  /**
   * POST /slices/:sliceId/interview/:sessionId/retry
   * Retry a failed slice interview session.
   *
   * UTILITY PATH: Independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post(
    "/slices/:sliceId/interview/:sessionId/retry",
    catchTypedHandler(async (req, res) => {
      const { sessionId } = req.params;

      if (!validateSliceId(req.params.sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const tabId = typeof req.body?.tabId === "string" && req.body.tabId.trim().length > 0
        ? req.body.tabId.trim()
        : undefined;
      const lockCheck = checkSessionLock(sessionId, tabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      try {
        const { retryTargetInterviewSession } = await import("./milestone-slice-interview.js");

        const rootDir = await getRootDirForRequest(req);
        await retryTargetInterviewSession(sessionId, rootDir);
        res.json({ success: true, sessionId });
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "TargetSessionNotFoundError") {
          throw notFound(errMsg);
        } else if (errName === "TargetInvalidSessionStateError") {
          throw badRequest(errMsg);
        } else {
          throw internalError(errMsg || "Failed to retry interview session");
        }
      }
    })
  );

  /**
   * POST /slices/:sliceId/interview/apply
   * Apply slice interview summary to the slice.
   * Body: { sessionId: string, summary?: TargetInterviewSummary }
   */
  router.post(
    "/slices/:sliceId/interview/apply",
    catchTypedHandler(async (req, res) => {
      const { sessionId } = req.body;

      if (!validateSliceId(req.params.sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      try {
        const { applyTargetInterview } = await import("./milestone-slice-interview.js");

        const slice = applyTargetInterview(sessionId, missionStore);
        res.json(slice);
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "TargetSessionNotFoundError") {
          throw notFound(errMsg);
        } else {
          throw internalError(errMsg || "Failed to apply interview");
        }
      }
    })
  );

  /**
   * POST /slices/:sliceId/interview/skip
   * Skip slice interview and apply mission-level context.
   */
  router.post(
    "/slices/:sliceId/interview/skip",
    catchTypedHandler(async (req, res) => {
      const { sliceId } = req.params;

      if (!validateSliceId(sliceId)) {
        throw badRequest("Invalid slice ID format");
      }

      try {
        const {
          skipTargetInterview,
        } = await import("./milestone-slice-interview.js");

        const slice = skipTargetInterview("slice", sliceId, missionStore);
        res.json(slice);
      } catch (err: unknown) {
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "TargetSessionNotFoundError") {
          throw notFound(errMsg);
        } else {
          throw internalError(errMsg || "Failed to skip interview");
        }
      }
    })
  );

  return router;
}
