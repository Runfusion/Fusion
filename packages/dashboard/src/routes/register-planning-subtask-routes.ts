import { resolvePlanningSettingsModel, type TaskStore, type PlanningSummary } from "@fusion/core";
import { ApiError, badRequest, notFound, rateLimited } from "../api-error.js";
import { writeSSEEvent, type SessionBufferedEvent } from "../sse-buffer.js";
import type { AiSessionStore } from "../ai-session-store.js";
import type { ApiRoutesContext } from "./types.js";

interface PlanningSubtaskRouteDeps {
  store: TaskStore;
  aiSessionStore?: AiSessionStore;
  checkSessionLock: (sessionId: string, tabId: string | undefined, store: AiSessionStore | undefined) => { allowed: true } | { allowed: false; currentHolder: string | null | undefined };
  parseLastEventId: (req: import("express").Request) => number | undefined;
  replayBufferedSSE: (res: import("express").Response, bufferedEvents: SessionBufferedEvent[]) => boolean;
}

export function registerPlanningSubtaskRoutes(ctx: ApiRoutesContext, deps: PlanningSubtaskRouteDeps): void {
  const { router, getProjectContext, planningLogger, rethrowAsApiError } = ctx;
  const { aiSessionStore, checkSessionLock, parseLastEventId, replayBufferedSSE } = deps;

  // ── Planning Mode Routes ──────────────────────────────────────────────────
  // UTILITY PATH: Planning and subtask session routes are on a separate control-plane lane.
  // They must NOT be gated on task-lane saturation (maxConcurrent, semaphore, queue depth).
  // These routes create/manage AI planning and subtask breakdown sessions.

  router.post("/subtasks/start-streaming", async (req, res) => {
    try {
      const { description } = req.body;

      if (!description || typeof description !== "string") {
        throw badRequest("description is required and must be a string");
      }

      if (description.length > 1000) {
        throw badRequest("description must be 1000 characters or less");
      }

      const { store: scopedStore, projectId } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { createSubtaskSession } = await import("../subtask-breakdown.js");
      const session = await createSubtaskSession(
        description,
        scopedStore,
        scopedStore.getRootDir(),
        settings.promptOverrides,
        projectId,
      );
      res.status(201).json({ sessionId: session.sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to start subtask breakdown");
    }
  });

  router.get("/subtasks/:sessionId/stream", async (req, res) => {
    const { sessionId } = req.params;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");

    try {
      const { subtaskStreamManager, getSubtaskSession } = await import("../subtask-breakdown.js");
      const session = getSubtaskSession(sessionId);
      if (!session) {
        writeSSEEvent(res, "error", JSON.stringify("Session not found or expired"));
        res.end();
        return;
      }

      const lastEventId = parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = subtaskStreamManager.getBufferedEvents(sessionId, lastEventId);
        if (!replayBufferedSSE(res, buffered)) {
          res.end();
          return;
        }
      }

      if (session.status === "complete") {
        const existing = subtaskStreamManager.getBufferedEvents(sessionId, 0);

        const lastSubtasksEvent = [...existing].reverse().find((event) => event.event === "subtasks");
        const subtasksEventId = lastSubtasksEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, {
            type: "subtasks",
            data: session.subtasks,
          });

        if (lastEventId === undefined || subtasksEventId > lastEventId) {
          if (!writeSSEEvent(res, "subtasks", JSON.stringify(session.subtasks), subtasksEventId)) {
            res.end();
            return;
          }
        }

        const lastCompleteEvent = [...existing].reverse().find((event) => event.event === "complete");
        const completeEventId = lastCompleteEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, { type: "complete" });

        if (lastEventId === undefined || completeEventId > lastEventId) {
          writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
        }

        res.end();
        return;
      }

      if (session.status === "error") {
        const errorMessage = String(session.error || "Unknown error");
        const existing = subtaskStreamManager.getBufferedEvents(sessionId, 0);
        const lastErrorEvent = [...existing].reverse().find((event) => event.event === "error");
        const errorEventId = lastErrorEvent?.id
          ?? subtaskStreamManager.broadcast(sessionId, {
            type: "error",
            data: errorMessage,
          });

        if (lastEventId === undefined || errorEventId > lastEventId) {
          writeSSEEvent(res, "error", JSON.stringify(errorMessage), errorEventId);
        }

        res.end();
        return;
      }

      const unsubscribe = subtaskStreamManager.subscribe(sessionId, (event, eventId) => {
        const data = (event as { data?: unknown }).data;
        if (!writeSSEEvent(res, event.type, JSON.stringify(data ?? {}), eventId)) {
          unsubscribe();
          return;
        }

        if (event.type === "complete" || event.type === "error") {
          unsubscribe();
          res.end();
        }
      });

      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(": heartbeat\n\n");
      }, 30_000);

      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      writeSSEEvent(res, "error", JSON.stringify(err instanceof Error ? err.message : String(err)));
      res.end();
    }
  });

  router.post("/subtasks/create-tasks", async (req, res) => {
    try {
      const { sessionId, subtasks, parentTaskId } = req.body as {
        sessionId?: string;
        subtasks?: Array<{ tempId: string; title: string; description: string; size?: "S" | "M" | "L"; dependsOn?: string[] }>;
        parentTaskId?: string;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        throw badRequest("subtasks must be a non-empty array");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { getSubtaskSession, cleanupSubtaskSession } = await import("../subtask-breakdown.js");
      const session = getSubtaskSession(sessionId);
      if (!session) {
        throw notFound(`Subtask session ${sessionId} not found or expired`);
      }

      // Fetch parent task to inherit model settings if parentTaskId is provided
      let parentTask: Awaited<ReturnType<TaskStore["getTask"]>> | undefined;
      if (typeof parentTaskId === "string" && parentTaskId.trim()) {
        try {
          parentTask = await scopedStore.getTask(parentTaskId);
        } catch {
          // Parent task not found or error - proceed without inheritance
          parentTask = undefined;
        }
      }

      const createdTasks = [] as Awaited<ReturnType<TaskStore["createTask"]>>[];
      const tempIdToTaskId = new Map<string, string>();

      for (const item of subtasks) {
        if (!item || typeof item.tempId !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          throw badRequest("Each subtask must include tempId and title");
        }

        const task = await scopedStore.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          column: "triage",
          dependencies: undefined,
          // Inherit parent's model settings if available
          modelProvider: parentTask?.modelProvider,
          modelId: parentTask?.modelId,
          validatorModelProvider: parentTask?.validatorModelProvider,
          validatorModelId: parentTask?.validatorModelId,
          source: { sourceType: "api", sourceParentTaskId: typeof parentTaskId === "string" ? parentTaskId : undefined },
        });

        tempIdToTaskId.set(item.tempId, task.id);
        createdTasks.push(task);

        if (item.size === "S" || item.size === "M" || item.size === "L") {
          await scopedStore.updateTask(task.id, { size: item.size });
        }
      }

      // Resolve each subtask's dependsOn list:
      //   - map tempIds to the newly-created sibling task ids
      //   - drop any reference to the parent being split (would be a dangling id after delete)
      //   - record dropped ids so the caller can surface them instead of silently losing them
      const droppedDependencies: Array<{ taskId: string; dropped: string[] }> = [];
      const normalizedParentId = typeof parentTaskId === "string" ? parentTaskId.trim() : "";

      for (let index = 0; index < subtasks.length; index++) {
        const item = subtasks[index]!;
        const created = createdTasks[index]!;
        const rawDeps = Array.isArray(item.dependsOn) ? item.dependsOn : [];
        const resolvedDependencies: string[] = [];
        const dropped: string[] = [];

        for (const dep of rawDeps) {
          if (typeof dep !== "string" || !dep) continue;
          if (normalizedParentId && dep === normalizedParentId) {
            // Parent is about to be deleted — depending on it would permanently
            // block the dependent.
            dropped.push(dep);
            continue;
          }
          const siblingId = tempIdToTaskId.get(dep);
          if (siblingId) {
            resolvedDependencies.push(siblingId);
            continue;
          }
          // Not a sibling tempId and not the parent — it could be an existing
          // task id. Keep it only if it resolves to a live task; otherwise drop.
          try {
            await scopedStore.getTask(dep);
            resolvedDependencies.push(dep);
          } catch {
            dropped.push(dep);
          }
        }

        if (resolvedDependencies.length > 0) {
          const updated = await scopedStore.updateTask(created.id, { dependencies: resolvedDependencies });
          createdTasks[index] = updated;
        }
        if (dropped.length > 0) {
          droppedDependencies.push({ taskId: created.id, dropped });
          await scopedStore.logEntry(
            created.id,
            `Subtask breakdown: dropped invalid dependencies [${dropped.join(", ")}] (parent-id or unknown task id)`,
          );
        }

        await scopedStore.logEntry(created.id, "Created via subtask breakdown", `Source: ${session.initialDescription.slice(0, 200)}`);
      }

      let parentTaskClosed = false;
      let parentTaskCloseError: string | undefined;
      if (normalizedParentId) {
        try {
          await scopedStore.deleteTask(normalizedParentId);
          parentTaskClosed = true;
        } catch (err: unknown) {
          // deleteTask refuses when live tasks still reference the parent id.
          // Keep the parent alive and surface the reason; silently failing here
          // is what left FN-2164 blocked by the ghost of FN-2163.
          parentTaskClosed = false;
          parentTaskCloseError = err instanceof Error ? err.message : String(err);
        }
      }

      cleanupSubtaskSession(sessionId);
      res.status(201).json({
        tasks: createdTasks,
        parentTaskClosed,
        parentTaskCloseError,
        droppedDependencies,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create tasks from breakdown");
    }
  });

  router.post("/subtasks/cancel", async (req, res) => {
    try {
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

      const { cancelSubtaskSession } = await import("../subtask-breakdown.js");
      await cancelSubtaskSession(sessionId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to cancel subtask session");
      }
    }
  });

  /**
   * POST /api/subtasks/:sessionId/retry
   * Retry a failed subtask breakdown session.
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post("/subtasks/:sessionId/retry", async (req, res) => {
    try {
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

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { retrySubtaskSession } = await import("../subtask-breakdown.js");
      await retrySubtaskSession(sessionId, scopedStore.getRootDir(), settings.promptOverrides);
      res.json({ success: true, sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (err instanceof Error && err.name === "InvalidSessionStateError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to retry subtask session");
      }
    }
  });

  /**
   * POST /api/planning/start
   * Start a new planning session.
   * Body: { initialPlan: string }
   * Returns: { sessionId: string, firstQuestion: PlanningQuestion }
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   */
  router.post("/planning/start", async (req, res) => {
    try {
      const { initialPlan } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        throw badRequest("initialPlan is required and must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = scopedStore.getRootDir();

      const { createSession, RateLimitError: _RateLimitError } = await import("../planning.js");
      const result = await createSession(
        ip,
        initialPlan,
        scopedStore,
        rootDir,
        settings.promptOverrides,
      );
      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else {
        rethrowAsApiError(err, "Failed to start planning session");
      }
    }
  });

  /**
   * POST /api/planning/start-streaming
   * Start a new planning session with AI agent streaming.
   * Body: { initialPlan: string }
   * Returns: { sessionId: string }
   *
   * After receiving sessionId, connect to GET /api/planning/:sessionId/stream
   * for real-time thinking output and questions.
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   */
  router.post("/planning/start-streaming", async (req, res) => {
    try {
      const { initialPlan, planningModelProvider, planningModelId } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        throw badRequest("initialPlan is required and must be a string");
      }

      if (planningModelProvider !== undefined && typeof planningModelProvider !== "string") {
        throw badRequest("planningModelProvider must be a string when provided");
      }

      if (planningModelId !== undefined && typeof planningModelId !== "string") {
        throw badRequest("planningModelId must be a string when provided");
      }

      const { store: scopedStore, projectId } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = scopedStore.getRootDir();

      // Resolve planning model using canonical lane hierarchy:
      // 1. Request body planning override
      // 2. Project/global planning lane
      // 3. Project default override
      // 4. Global default
      const resolvedPlanningSettings = resolvePlanningSettingsModel(settings);
      const resolvedPlanningProvider =
        (planningModelProvider && planningModelId ? planningModelProvider : undefined) ||
        resolvedPlanningSettings.provider;

      const resolvedPlanningModelId =
        (planningModelProvider && planningModelId ? planningModelId : undefined) ||
        resolvedPlanningSettings.modelId;

      const { createSessionWithAgent, RateLimitError: _RateLimitError2 } = await import("../planning.js");
      const sessionId = await createSessionWithAgent(
        ip,
        initialPlan,
        rootDir,
        resolvedPlanningProvider,
        resolvedPlanningModelId,
        settings.promptOverrides,
        {
          projectId,
          ntfyConfig: {
            enabled: settings.ntfyEnabled ?? false,
            topic: settings.ntfyTopic,
            dashboardHost: settings.ntfyDashboardHost,
            events: settings.ntfyEvents,
          },
        },
      );
      res.status(201).json({ sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      } else {
        rethrowAsApiError(err, "Failed to start planning session");
      }
    }
  });

  /**
   * POST /api/planning/respond
   * Submit a response to the current planning question.
   * Body: { sessionId: string, responses: Record<string, unknown> }
   * Returns: { type: "question" | "complete", data: PlanningQuestion | PlanningSummary }
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved (multi-tab coordination, not saturation).
   */
  router.post("/planning/respond", async (req, res) => {
    try {
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

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { submitResponse, SessionNotFoundError: _SessionNotFoundError, InvalidSessionStateError: _InvalidSessionStateError } = await import("../planning.js");
      const result = await submitResponse(
        sessionId,
        responses,
        scopedStore.getRootDir(),
        settings.promptOverrides,
      );
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (err instanceof Error && err.name === "InvalidSessionStateError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to process response");
      }
    }
  });

  /**
   * POST /api/planning/:sessionId/retry
   * Retry a failed planning session.
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   * Session-lock 409 with { error, lockedByTab } is preserved.
   */
  router.post("/planning/:sessionId/retry", async (req, res) => {
    try {
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

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { retrySession } = await import("../planning.js");
      await retrySession(sessionId, scopedStore.getRootDir(), settings.promptOverrides);
      res.json({ success: true, sessionId });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (err instanceof Error && err.name === "InvalidSessionStateError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to retry planning session");
      }
    }
  });

  router.post("/planning/:sessionId/stop", async (req, res) => {
    try {
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

      const { stopGeneration } = await import("../planning.js");
      const stopped = stopGeneration(sessionId);
      if (!stopped) {
        throw notFound(`Planning session ${sessionId} not found or expired`);
      }

      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to stop planning session");
    }
  });

  /**
   * POST /api/planning/cancel
   * Cancel and cleanup a planning session.
   * Body: { sessionId: string }
   */
  router.post("/planning/cancel", async (req, res) => {
    try {
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

      const { cancelSession, SessionNotFoundError: _SessionNotFoundError2 } = await import("../planning.js");
      await cancelSession(sessionId);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to cancel session");
      }
    }
  });

  const parsePlanningSummaryOverride = (summaryInput: unknown): PlanningSummary | undefined => {
    if (summaryInput === undefined) {
      return undefined;
    }

    if (!summaryInput || typeof summaryInput !== "object" || Array.isArray(summaryInput)) {
      throw badRequest("summary must be an object");
    }

    const summary = summaryInput as Partial<PlanningSummary>;

    if (typeof summary.title !== "string" || summary.title.trim().length === 0) {
      throw badRequest("summary.title is required and must be a non-empty string");
    }

    if (typeof summary.description !== "string" || summary.description.trim().length === 0) {
      throw badRequest("summary.description is required and must be a non-empty string");
    }

    return {
      title: summary.title.trim(),
      description: summary.description.trim(),
      suggestedSize:
        summary.suggestedSize === "S" || summary.suggestedSize === "M" || summary.suggestedSize === "L"
          ? summary.suggestedSize
          : "M",
      suggestedDependencies: Array.isArray(summary.suggestedDependencies)
        ? summary.suggestedDependencies.filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0)
        : [],
      keyDeliverables: Array.isArray(summary.keyDeliverables)
        ? summary.keyDeliverables.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    };
  };

  /**
   * POST /api/planning/create-task
   * Create a task from a completed planning session.
   * Body: { sessionId: string }
   * Returns: Created Task
   */
  router.post("/planning/create-task", async (req, res) => {
    try {
      const { sessionId, summary: summaryInput } = req.body as {
        sessionId?: unknown;
        summary?: unknown;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const summaryOverride = parsePlanningSummaryOverride(summaryInput);

      const { store: scopedStore } = await getProjectContext(req);
      const { getSession, getSummary, cleanupSession } = await import("../planning.js");

      const session = getSession(sessionId);
      let summary = summaryOverride ?? getSummary(sessionId);
      let initialPlan = session?.initialPlan;
      let usedPersistedFallback = false;

      if (!session) {
        if (!aiSessionStore) {
          throw notFound(`Planning session ${sessionId} not found or expired`);
        }

        const persistedSession = aiSessionStore.get(sessionId);
        if (!persistedSession || persistedSession.type !== "planning") {
          throw notFound(`Planning session ${sessionId} not found or expired`);
        }

        if (persistedSession.status !== "complete") {
          throw badRequest("Planning session is not complete");
        }

        if (!persistedSession.result) {
          throw badRequest("Planning session result is not available");
        }

        if (!summaryOverride) {
          try {
            const parsedSummary = JSON.parse(persistedSession.result) as {
              title?: unknown;
              description?: unknown;
              suggestedSize?: unknown;
              suggestedDependencies?: unknown;
              keyDeliverables?: unknown;
            };

            summary = {
              title:
                typeof parsedSummary.title === "string" && parsedSummary.title.trim().length > 0
                  ? parsedSummary.title
                  : persistedSession.title,
              description:
                typeof parsedSummary.description === "string" && parsedSummary.description.trim().length > 0
                  ? parsedSummary.description
                  : persistedSession.title,
              suggestedSize:
                parsedSummary.suggestedSize === "S" ||
                parsedSummary.suggestedSize === "M" ||
                parsedSummary.suggestedSize === "L"
                  ? parsedSummary.suggestedSize
                  : "M",
              suggestedDependencies: Array.isArray(parsedSummary.suggestedDependencies)
                ? parsedSummary.suggestedDependencies.filter((dep): dep is string => typeof dep === "string")
                : [],
              keyDeliverables: Array.isArray(parsedSummary.keyDeliverables)
                ? parsedSummary.keyDeliverables.filter((item): item is string => typeof item === "string")
                : [],
            };
          } catch {
            throw badRequest("Planning session result is invalid");
          }
        }

        try {
          const parsedInput = JSON.parse(persistedSession.inputPayload) as { initialPlan?: unknown };
          if (typeof parsedInput.initialPlan === "string" && parsedInput.initialPlan.trim().length > 0) {
            initialPlan = parsedInput.initialPlan;
          }
        } catch {
          // Keep fallback value below
        }

        if (!initialPlan) {
          initialPlan = persistedSession.title;
        }

        usedPersistedFallback = true;
      }

      if (!summary) {
        throw badRequest("Planning session is not complete");
      }

      // Create the task
      const task = await scopedStore.createTask({
        title: summary.title,
        description: summary.description,
        column: "triage",
        dependencies: summary.suggestedDependencies.length > 0 ? summary.suggestedDependencies : undefined,
        source: { sourceType: "api" },
      });

      // Update task with suggested size if provided
      if (summary.suggestedSize) {
        await scopedStore.updateTask(task.id, { size: summary.suggestedSize });
      }

      // Log the planning mode creation
      await scopedStore.logEntry(task.id, "Created via Planning Mode", `Initial plan: ${(initialPlan ?? "").slice(0, 200)}`);

      // Cleanup the session
      if (usedPersistedFallback) {
        aiSessionStore?.delete(sessionId);
      } else {
        cleanupSession(sessionId);
      }

      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create task");
    }
  });

  /**
   * POST /api/planning/start-breakdown
   * Start subtask breakdown from a completed planning session.
   * Body: { sessionId: string }
   * Returns: { sessionId: string } — ID of the generated subtask breakdown
   */
  router.post("/planning/start-breakdown", async (req, res) => {
    try {
      const { sessionId, summary: summaryInput } = req.body as {
        sessionId?: unknown;
        summary?: unknown;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const summaryOverride = parsePlanningSummaryOverride(summaryInput);

      const { getSession, generateSubtasksFromPlanning } = await import("../planning.js");

      const session = getSession(sessionId);
      if (!session) {
        throw notFound(`Planning session ${sessionId} not found or expired`);
      }

      if (summaryOverride) {
        session.summary = summaryOverride;
      }

      if (!session.summary) {
        throw badRequest("Planning session is not complete");
      }

      const subtasks = generateSubtasksFromPlanning(sessionId);
      if (subtasks.length === 0) {
        throw badRequest("Could not generate subtasks from planning session");
      }

      // Return a synthetic session ID (based on the planning session) and the generated subtasks
      // We use the planning session ID directly as the breakdown session ID
      res.json({ sessionId, subtasks });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to start planning breakdown");
    }
  });

  /**
   * POST /api/planning/create-tasks
   * Create multiple tasks from a completed planning session (after optional editing).
   * Body: { planningSessionId: string, subtasks: Array<{id, title, description, suggestedSize, dependsOn}> }
   * Returns: { tasks: Task[] }
   */
  router.post("/planning/create-tasks", async (req, res) => {
    try {
      const { planningSessionId, subtasks } = req.body as {
        planningSessionId?: string;
        subtasks?: Array<{
          id: string;
          title: string;
          description: string;
          suggestedSize: "S" | "M" | "L";
          dependsOn: string[];
        }>;
      };

      if (!planningSessionId || typeof planningSessionId !== "string") {
        throw badRequest("planningSessionId is required");
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        throw badRequest("subtasks must be a non-empty array");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { getSession, cleanupSession, formatInterviewQA } = await import("../planning.js");

      const session = getSession(planningSessionId);
      if (!session) {
        throw notFound(`Planning session ${planningSessionId} not found or expired`);
      }

      if (!session.summary) {
        throw badRequest("Planning session is not complete");
      }

      const qaSection = formatInterviewQA(session.history);
      const logDetails = qaSection
        ? `Source: ${session.initialPlan.slice(0, 200)}\n\n${qaSection}`
        : `Source: ${session.initialPlan.slice(0, 200)}`;

      // Validate each subtask
      for (const item of subtasks) {
        if (!item || typeof item.id !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          throw badRequest("Each subtask must include id and title");
        }
      }

      const createdTasks = [] as Awaited<ReturnType<TaskStore["createTask"]>>[];
      const tempIdToTaskId = new Map<string, string>();

      // Create tasks
      for (const item of subtasks) {
        const task = await scopedStore.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          column: "triage",
          dependencies: undefined,
          source: { sourceType: "api", sourceMetadata: { planningSessionId } },
        });

        tempIdToTaskId.set(item.id, task.id);
        createdTasks.push(task);

        if (item.suggestedSize === "S" || item.suggestedSize === "M" || item.suggestedSize === "L") {
          await scopedStore.updateTask(task.id, { size: item.suggestedSize });
        }
      }

      // Resolve dependencies
      for (let index = 0; index < subtasks.length; index++) {
        const item = subtasks[index]!;
        const created = createdTasks[index]!;
        const resolvedDependencies = Array.isArray(item.dependsOn)
          ? item.dependsOn.map((dep) => tempIdToTaskId.get(dep)).filter((dep): dep is string => Boolean(dep))
          : [];

        if (resolvedDependencies.length > 0) {
          const updated = await scopedStore.updateTask(created.id, { dependencies: resolvedDependencies });
          createdTasks[index] = updated;
        }

        await scopedStore.logEntry(created.id, "Created via Planning Mode (multi-task)", logDetails);
      }

      // Cleanup the planning session
      cleanupSession(planningSessionId);

      res.status(201).json({ tasks: createdTasks });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to create tasks from planning");
    }
  });

  /**
   * GET /api/planning/:sessionId/stream
   * SSE endpoint for real-time planning session updates.
   * Streams thinking output, questions, summaries, and errors.
   * 
   * Event types:
   * - thinking: AI thinking output chunks
   * - question: New question to display
   * - summary: Planning summary when complete
   * - error: Error message
   * - complete: Stream completed
   */
  router.get("/planning/:sessionId/stream", async (req, res) => {
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
      const { planningStreamManager, getSession } = await import("../planning.js");

      // Verify session exists
      const session = getSession(sessionId);
      if (!session) {
        writeSSEEvent(res, "error", JSON.stringify({ message: "Session not found or expired" }));
        res.end();
        return;
      }

      const lastEventId = parseLastEventId(req);
      if (lastEventId !== undefined) {
        const buffered = planningStreamManager.getBufferedEvents(sessionId, lastEventId);
        if (!replayBufferedSSE(res, buffered)) {
          res.end();
          return;
        }
      }

      if (session.summary) {
        const existing = planningStreamManager.getBufferedEvents(sessionId, 0);
        const lastSummaryEvent = [...existing].reverse().find((event) => event.event === "summary");
        const summaryEventId = lastSummaryEvent?.id
          ?? planningStreamManager.broadcast(sessionId, {
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
          ?? planningStreamManager.broadcast(sessionId, { type: "complete" });

        if (lastEventId === undefined || completeEventId > lastEventId) {
          writeSSEEvent(res, "complete", JSON.stringify({}), completeEventId);
        }

        res.end();
        return;
      }

      // Catch-up for awaiting_input sessions: emit current question immediately
      // so late subscribers don't miss the transition and see the question without delay
      if (session.currentQuestion) {
        const existing = planningStreamManager.getBufferedEvents(sessionId, 0);
        const lastQuestionEvent = [...existing].reverse().find((event) => event.event === "question");
        const questionEventId = lastQuestionEvent?.id
          ?? planningStreamManager.broadcast(sessionId, {
            type: "question",
            data: session.currentQuestion,
          });

        if (lastEventId === undefined || questionEventId > lastEventId) {
          if (!writeSSEEvent(res, "question", JSON.stringify(session.currentQuestion), questionEventId)) {
            res.end();
            return;
          }
        }
        // Don't return — subscribe to continue receiving events (thinking, next question, etc.)
      } else if (lastEventId === undefined) {
        // First-connect catch-up for a session that is still generating its
        // first response: there is no question or summary yet, but the agent
        // may already be streaming thinking deltas into the buffer faster
        // than the client could establish the SSE connection. Replay every
        // buffered event so the user sees the running thinking output from
        // the start of generation, especially on slower mobile connections.
        const buffered = planningStreamManager.getBufferedEvents(sessionId, 0);
        if (!replayBufferedSSE(res, buffered)) {
          res.end();
          return;
        }
      }

      // Subscribe to session events
      const unsubscribe = planningStreamManager.subscribe(sessionId, (event, eventId) => {
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

      // Send heartbeat every 30s to keep connection alive
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
      if (err instanceof ApiError) {
        throw err;
      }
      writeSSEEvent(res, "error", JSON.stringify({ message: err instanceof Error ? err.message : String(err) || "Stream error" }));
      res.end();
    }
  });


  if (process.env.FUSION_DEBUG_PLANNING_ROUTES === "1") {
    const planningRoutes = [
      "POST /planning/start",
      "POST /planning/start-streaming",
      "POST /planning/respond",
      "POST /planning/:sessionId/retry",
      "POST /planning/:sessionId/stop",
      "POST /planning/cancel",
      "POST /planning/create-task",
      "POST /planning/start-breakdown",
      "POST /planning/create-tasks",
      "GET /planning/:sessionId/stream",
    ];
    planningLogger.info("routes registered", { planningRoutes });
  }
}
