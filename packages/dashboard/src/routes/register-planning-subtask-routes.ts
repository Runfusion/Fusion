import {
  DEFAULT_TASK_PRIORITY,
  resolvePlanningSettingsModel,
  TASK_PRIORITIES,
  THINKING_LEVELS,
  type PlanningSummary,
  type TaskPriority,
  type TaskStore,
  type ThinkingLevel,
} from "@fusion/core";
import { normalizePlanningSummaryPayload } from "../planning.js";
import { ApiError, badRequest, conflict, notFound, rateLimited } from "../api-error.js";
import { writeSSEEvent, type SessionBufferedEvent } from "../sse-buffer.js";
import type { AiSessionStore } from "../ai-session-store.js";
import type { ApiRoutesContext } from "./types.js";
import { resolveBranchAssignmentContext, resolveBranchSelection, resolveEntryPointBranchAssignment } from "./branch-selection.js";

type SkillPluginRunner = Parameters<typeof import("@fusion/engine").buildSessionSkillContextSync>[3];

interface PlanningSubtaskRouteDeps {
  store: TaskStore;
  aiSessionStore?: AiSessionStore;
  checkSessionLock: (sessionId: string, tabId: string | undefined, store: AiSessionStore | undefined) => Promise<{ allowed: true } | { allowed: false; currentHolder: string | null | undefined }>;
  parseLastEventId: (req: import("express").Request) => number | undefined;
  replayBufferedSSE: (res: import("express").Response, bufferedEvents: SessionBufferedEvent[]) => boolean;
}

function rethrowPlanningWorkflowCreateError(
  err: unknown,
  fallbackMessage: string,
  rethrowAsApiError: ApiRoutesContext["rethrowAsApiError"],
): never {
  if (err instanceof ApiError) {
    throw err;
  }

  const message = err instanceof Error ? err.message : String(err || fallbackMessage);
  const isWorkflowClientError =
    /^Workflow '.*' not found$/.test(message)
    || /is a fragment and cannot be selected/.test(message);

  if (isWorkflowClientError) {
    throw new ApiError(400, message);
  }

  rethrowAsApiError(err, fallbackMessage);
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
      const session = await getSubtaskSession(sessionId);
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
      const { sessionId, subtasks, parentTaskId, branch, baseBranch, branchSelection, branchAssignment, workflowId } = req.body as {
        sessionId?: string;
        subtasks?: Array<{ tempId: string; title: string; description: string; size?: "S" | "M" | "L"; dependsOn?: string[] }>;
        parentTaskId?: string;
        branch?: unknown;
        baseBranch?: unknown;
        branchSelection?: unknown;
        branchAssignment?: unknown;
        workflowId?: unknown;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        throw badRequest("subtasks must be a non-empty array");
      }

      if (workflowId !== undefined && workflowId !== null && typeof workflowId !== "string") {
        throw badRequest("workflowId must be a string or null");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { getSubtaskSession, cleanupSubtaskSession } = await import("../subtask-breakdown.js");
      const session = await getSubtaskSession(sessionId);
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

      const { branch: resolvedBranch, baseBranch: resolvedBaseBranch } =
        resolveBranchSelection(branchSelection, branch, baseBranch);
      // Planning subtasks have no strategy fallback; keep the historical shared default.
      const { mode: branchMode = "shared" } = resolveBranchAssignmentContext(branchAssignment);
      // Stamp the real BranchGroup id (BG-…) so listTasksByBranchGroup(group.id)
      // resolves members. The group is only ensured (and the id set) in shared
      // mode below. Non-shared members get NO groupId — stamping a synthetic
      // `planning:<id>` would let the legacy membership fallback sweep them into
      // a shared group later created for the same planning session.
      let planningGroupId: string | undefined;

      if (branchMode === "shared") {
        const settings = await scopedStore.getSettings();
        const settingsDefaultBranch =
          typeof settings.defaultBranch === "string" && settings.defaultBranch.trim().length > 0
            ? settings.defaultBranch
            : "main";
        const settingsAutoMerge = typeof settings.autoMerge === "boolean" ? settings.autoMerge : false;
        const branchGroupStore = scopedStore as { ensureBranchGroupForSource?: TaskStore["ensureBranchGroupForSource"] };
        const group = await branchGroupStore.ensureBranchGroupForSource?.("planning", sessionId, {
          branchName: resolvedBranch ?? resolvedBaseBranch ?? settingsDefaultBranch,
          autoMerge: session.autoMerge ?? settingsAutoMerge,
        });
        if (group) {
          planningGroupId = group.id;
        }
      }

      const planningBranchContext = {
        ...(planningGroupId ? { groupId: planningGroupId } : {}),
        source: "planning" as const,
        assignmentMode: branchMode,
        inheritedBaseBranch: resolvedBaseBranch,
      };

      const createdTasks = [] as Awaited<ReturnType<TaskStore["createTask"]>>[];
      const tempIdToTaskId = new Map<string, string>();

      for (const item of subtasks) {
        if (!item || typeof item.tempId !== "string" || typeof item.title !== "string" || !item.title.trim()) {
          throw badRequest("Each subtask must include tempId and title");
        }

        const { workingBranch: taskBranch } = resolveEntryPointBranchAssignment({
          assignmentMode: branchMode,
          resolvedBranch,
          taskSegment: item.title || item.tempId,
        });

        /*
        FNXC:Workflows 2026-07-05-00:00:
        FN-7611: do not hardcode column here. This route accepts an explicit workflowId
        (below), so a hardcoded "triage" would defeat that custom workflow's own intake
        column resolution. Omitting `column` lets the store resolve intake for the
        selected-or-default workflow (byte-identical "triage" for builtin:coding).
        */
        const task = await scopedStore.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          dependencies: undefined,
          // Inherit parent's model settings if available
          modelProvider: parentTask?.modelProvider,
          modelId: parentTask?.modelId,
          validatorModelProvider: parentTask?.validatorModelProvider,
          validatorModelId: parentTask?.validatorModelId,
          source: { sourceType: "api", sourceParentTaskId: typeof parentTaskId === "string" ? parentTaskId : undefined },
          branch: taskBranch,
          baseBranch: resolvedBaseBranch,
          branchContext: planningBranchContext,
          /*
          FNXC:WorkflowSelection 2026-06-20-16:48:
          Tasks created from a workflow lane via subtask breakdown must stay on that active workflow instead of falling back to the project default board.
          */
          ...(workflowId !== undefined ? { workflowId: workflowId as string | null } : {}),
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
          await scopedStore.deleteTask(normalizedParentId, {
            auditContext: {
              agentId: "system",
              runId: `synthetic-planning-delete-${normalizedParentId}-${Date.now()}`,
              sessionId,
            },
          });
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
      rethrowPlanningWorkflowCreateError(err, "Failed to create tasks from breakdown", rethrowAsApiError);
    }
  });

  router.post("/subtasks/cancel", async (req, res) => {
    try {
      const { sessionId, tabId } = req.body;
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const normalizedTabId = typeof tabId === "string" && tabId.trim().length > 0 ? tabId.trim() : undefined;
      const lockCheck = await checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
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
      const lockCheck = await checkSessionLock(sessionId, tabId, aiSessionStore);
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
      await retrySubtaskSession(sessionId, scopedStore.getRootDir(), settings.promptOverrides, scopedStore);
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
      const { initialPlan, planningDepth, customQuestionCount } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        throw badRequest("initialPlan is required and must be a string");
      }

      if (
        planningDepth !== undefined
        && planningDepth !== "small"
        && planningDepth !== "medium"
        && planningDepth !== "large"
      ) {
        throw badRequest('planningDepth must be one of "small", "medium", or "large" when provided');
      }

      if (
        customQuestionCount !== undefined
        && (!Number.isInteger(customQuestionCount) || customQuestionCount < 1 || customQuestionCount > 20)
      ) {
        throw badRequest("customQuestionCount must be an integer between 1 and 20 when provided");
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
        planningDepth,
        customQuestionCount,
        ctx.options?.pluginRunner as SkillPluginRunner,
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
   * POST /api/planning/create-draft
   * Body: { initialPlan: string, planningModelProvider?: string, planningModelId?: string, thinkingLevel?: ThinkingLevel }
   */
  router.post("/planning/create-draft", async (req, res) => {
    try {
      const { initialPlan, planningModelProvider, planningModelId, thinkingLevel } = req.body;

      if (!initialPlan || typeof initialPlan !== "string" || initialPlan.trim().length === 0) {
        throw badRequest("initialPlan is required and must be a string");
      }

      if (planningModelProvider !== undefined && typeof planningModelProvider !== "string") {
        throw badRequest("planningModelProvider must be a string when provided");
      }

      if (planningModelId !== undefined && typeof planningModelId !== "string") {
        throw badRequest("planningModelId must be a string when provided");
      }

      if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) {
        throw badRequest("thinkingLevel must be one of: " + THINKING_LEVELS.join(", "));
      }
      const validatedThinkingLevel = thinkingLevel as ThinkingLevel | undefined;

      const { store: scopedStore, projectId } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const rootDir = scopedStore.getRootDir();

      const resolvedPlanningSettings = resolvePlanningSettingsModel(settings);
      const resolvedPlanningProvider =
        (planningModelProvider && planningModelId ? planningModelProvider : undefined) ||
        resolvedPlanningSettings.provider;

      const resolvedPlanningModelId =
        (planningModelProvider && planningModelId ? planningModelId : undefined) ||
        resolvedPlanningSettings.modelId;

      const { createDraftSession } = await import("../planning.js");
      const draft = validatedThinkingLevel
        ? await createDraftSession(
            ip,
            initialPlan,
            rootDir,
            resolvedPlanningProvider,
            resolvedPlanningModelId,
            validatedThinkingLevel,
            settings.promptOverrides,
            { projectId },
          )
        : await createDraftSession(
            ip,
            initialPlan,
            rootDir,
            resolvedPlanningProvider,
            resolvedPlanningModelId,
            settings.promptOverrides,
            { projectId },
          );
      res.status(201).json(draft);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "RateLimitError") {
        throw rateLimited(err.message);
      }
      rethrowAsApiError(err, "Failed to create planning draft");
    }
  });

  /**
   * POST /api/planning/start-streaming
   * Start a new planning session with AI agent streaming.
   * Body: { initialPlan: string, planningModelProvider?: string, planningModelId?: string, thinkingLevel?: ThinkingLevel }
   * Returns: { sessionId: string }
   *
   * After receiving sessionId, connect to GET /api/planning/:sessionId/stream
   * for real-time thinking output and questions.
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   */
  router.post("/planning/start-streaming", async (req, res) => {
    try {
      const {
        initialPlan,
        planningModelProvider,
        planningModelId,
        planningDepth,
        customQuestionCount,
        existingSessionId,
        thinkingLevel,
      } = req.body;

      if (!initialPlan || typeof initialPlan !== "string") {
        throw badRequest("initialPlan is required and must be a string");
      }

      if (planningModelProvider !== undefined && typeof planningModelProvider !== "string") {
        throw badRequest("planningModelProvider must be a string when provided");
      }

      if (planningModelId !== undefined && typeof planningModelId !== "string") {
        throw badRequest("planningModelId must be a string when provided");
      }

      if (
        planningDepth !== undefined
        && planningDepth !== "small"
        && planningDepth !== "medium"
        && planningDepth !== "large"
      ) {
        throw badRequest('planningDepth must be one of "small", "medium", or "large" when provided');
      }

      if (
        customQuestionCount !== undefined
        && (!Number.isInteger(customQuestionCount) || customQuestionCount < 1 || customQuestionCount > 20)
      ) {
        throw badRequest("customQuestionCount must be an integer between 1 and 20 when provided");
      }

      if (existingSessionId !== undefined && typeof existingSessionId !== "string") {
        throw badRequest("existingSessionId must be a string when provided");
      }

      if (thinkingLevel !== undefined && !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel)) {
        throw badRequest("thinkingLevel must be one of: " + THINKING_LEVELS.join(", "));
      }
      const validatedThinkingLevel = thinkingLevel as ThinkingLevel | undefined;

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

      if (existingSessionId) {
        // Defeat the start-before-debounced-sync race: the textarea contents
        // submitted with this request are authoritative — write them through
        // to the draft row before startExistingSession reads back from SQLite.
        // Otherwise a Start Planning click within the 500 ms debounce window
        // would launch the session against stale text.
        if (aiSessionStore) {
          try {
            await aiSessionStore.updateDraft(existingSessionId, {
              initialPlan,
              // Persist the explicit body override (if both fields set) so a
              // later summarizeDraftTitle picks the same model the user just
              // chose; pass undefined to clear any half-set state otherwise.
              modelProvider: planningModelProvider && planningModelId ? planningModelProvider : undefined,
              modelId: planningModelProvider && planningModelId ? planningModelId : undefined,
              thinkingLevel: validatedThinkingLevel,
            });
          } catch (error) {
            planningLogger.warn(
              "Failed to flush draft initialPlan before start",
              { sessionId: existingSessionId, error: String(error) },
            );
          }
        }
        const { startExistingSession } = await import("../planning.js");
        if (validatedThinkingLevel) {
          await startExistingSession(
            existingSessionId,
            rootDir,
            scopedStore,
            resolvedPlanningProvider,
            resolvedPlanningModelId,
            validatedThinkingLevel,
            settings.promptOverrides,
            ctx.options?.pluginRunner as SkillPluginRunner,
          );
        } else {
          await startExistingSession(
            existingSessionId,
            rootDir,
            scopedStore,
            resolvedPlanningProvider,
            resolvedPlanningModelId,
            settings.promptOverrides,
            ctx.options?.pluginRunner as SkillPluginRunner,
          );
        }
        res.status(201).json({ sessionId: existingSessionId });
        return;
      }

      const { createSessionWithAgent, RateLimitError: _RateLimitError2 } = await import("../planning.js");
      const planningOptions = {
        projectId,
        ntfyConfig: {
          enabled: settings.ntfyEnabled ?? false,
          topic: settings.ntfyTopic,
          dashboardHost: settings.ntfyDashboardHost,
          events: settings.ntfyEvents,
        },
        planningDepth,
        customQuestionCount,
        pluginRunner: ctx.options?.pluginRunner as SkillPluginRunner,
      };
      const sessionId = validatedThinkingLevel
        ? await createSessionWithAgent(
            ip,
            initialPlan,
            rootDir,
            scopedStore,
            resolvedPlanningProvider,
            resolvedPlanningModelId,
            validatedThinkingLevel,
            settings.promptOverrides,
            planningOptions,
          )
        : await createSessionWithAgent(
            ip,
            initialPlan,
            rootDir,
            scopedStore,
            resolvedPlanningProvider,
            resolvedPlanningModelId,
            settings.promptOverrides,
            planningOptions,
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
   * POST /api/planning/:sessionId/summarize-draft-title
   * Generate (or regenerate) the sidebar title for a draft session from its
   * latest persisted initialPlan. Fired by the modal on textarea blur and on
   * close so that drafts the user walks away from end up with a real title
   * instead of "New planning session". Idempotent server-side: only acts on
   * draft rows still holding the placeholder title.
   *
   * UTILITY PATH: This route is independent of task-lane saturation.
   */
  router.post("/planning/:sessionId/summarize-draft-title", async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId) {
        throw badRequest("sessionId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const rootDir = scopedStore.getRootDir();
      const resolvedPlanningSettings = resolvePlanningSettingsModel(settings);

      const { summarizeDraftTitle } = await import("../planning.js");
      const title = await summarizeDraftTitle(
        sessionId,
        rootDir,
        resolvedPlanningSettings.provider,
        resolvedPlanningSettings.modelId,
      );

      res.json({ title });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to summarize draft title");
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
      const lockCheck = await checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
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
        scopedStore,
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
      } else if (err instanceof Error && err.name === "GenerationInProgressError") {
        throw conflict(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to process response");
      }
    }
  });

  router.post("/planning/:sessionId/back", async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      const tabId = typeof req.body?.tabId === "string" && req.body.tabId.trim().length > 0
        ? req.body.tabId.trim()
        : undefined;
      const lockCheck = await checkSessionLock(sessionId, tabId, aiSessionStore);
      if (!lockCheck.allowed) {
        res.status(409).json({
          error: "Session locked by another tab",
          lockedByTab: lockCheck.currentHolder,
        });
        return;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const settings = await scopedStore.getSettings();
      const { rewindSession } = await import("../planning.js");
      const rewound = await rewindSession(
        sessionId,
        scopedStore.getRootDir(),
        settings.promptOverrides,
        scopedStore,
      );
      res.json(rewound);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (err instanceof Error && err.name === "InvalidSessionStateError") {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err, "Failed to rewind planning session");
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
      const lockCheck = await checkSessionLock(sessionId, tabId, aiSessionStore);
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
      await retrySession(sessionId, scopedStore.getRootDir(), settings.promptOverrides, scopedStore);
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
      const lockCheck = await checkSessionLock(sessionId, tabId, aiSessionStore);
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
      const lockCheck = await checkSessionLock(sessionId, normalizedTabId, aiSessionStore);
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

  const isTaskPriority = (value: unknown): value is TaskPriority =>
    typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);

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

    return normalizePlanningSummaryPayload(summary, {
      title: summary.title.trim(),
      description: summary.description.trim(),
    });
  };

  const logPlanningCreateWarning = (message: string, error: unknown, metadata?: Record<string, unknown>): void => {
    planningLogger.warn(message, {
      ...metadata,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const runPlanningCreateSideEffect = async (
    message: string,
    work: () => Promise<unknown> | unknown,
    metadata?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await work();
    } catch (error) {
      logPlanningCreateWarning(message, error, metadata);
    }
  };

  /**
   * POST /api/planning/create-task
   * Create a task from a completed planning session.
   * Body: { sessionId: string }
   * Returns: Created Task
   */
  router.post("/planning/create-task", async (req, res) => {
    try {
      const { sessionId, summary: summaryInput, branch, baseBranch, branchSelection, workflowId } = req.body as {
        sessionId?: unknown;
        summary?: unknown;
        branch?: unknown;
        baseBranch?: unknown;
        branchSelection?: unknown;
        workflowId?: unknown;
      };

      if (!sessionId || typeof sessionId !== "string") {
        throw badRequest("sessionId is required");
      }

      if (workflowId !== undefined && workflowId !== null && typeof workflowId !== "string") {
        throw badRequest("workflowId must be a string or null");
      }

      const summaryOverride = parsePlanningSummaryOverride(summaryInput);

      const { store: scopedStore } = await getProjectContext(req);
      const { getSession, getSummary, releaseSession } = await import("../planning.js");

      const session = await getSession(sessionId);
      let summary = summaryOverride ?? getSummary(sessionId);
      let initialPlan = session?.initialPlan;

      if (!session) {
        if (!aiSessionStore) {
          throw notFound(`Planning session ${sessionId} not found or expired`);
        }

        const persistedSession = await aiSessionStore.get(sessionId);
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
              priority?: unknown;
              suggestedDependencies?: unknown;
              keyDeliverables?: unknown;
            };

            summary = normalizePlanningSummaryPayload(parsedSummary, {
              title: persistedSession.title,
              description: persistedSession.title,
            });
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

      }

      if (!summary) {
        throw badRequest("Planning session is not complete");
      }

      const { branch: resolvedBranch, baseBranch: resolvedBaseBranch } =
        resolveBranchSelection(branchSelection, branch, baseBranch);

      /*
      FNXC:Workflows 2026-07-05-00:00:
      FN-7611: do not hardcode column here. This route accepts an explicit workflowId
      (below), so a hardcoded "triage" would defeat that custom workflow's own intake
      column resolution. Omitting `column` lets the store resolve intake for the
      selected-or-default workflow (byte-identical "triage" for builtin:coding).
      */
      // Create the task
      const task = await scopedStore.createTask({
        title: summary.title,
        description: summary.description,
        dependencies: summary.suggestedDependencies.length > 0 ? summary.suggestedDependencies : undefined,
        priority: isTaskPriority(summary.priority) ? summary.priority : DEFAULT_TASK_PRIORITY,
        source: { sourceType: "api" },
        branch: resolvedBranch,
        baseBranch: resolvedBaseBranch,
        /*
        FNXC:WorkflowSelection 2026-06-20-16:48:
        Planning Mode creates tasks from the board context, so an active workflow lane must be materialized at create time when the client supplies it.
        */
        ...(workflowId !== undefined ? { workflowId: workflowId as string | null } : {}),
      });

      // Update task with suggested size if provided.
      if (summary.suggestedSize) {
        await runPlanningCreateSideEffect(
          "Planning create-task size update failed",
          () => scopedStore.updateTask(task.id, { size: summary.suggestedSize }),
          { taskId: task.id, sessionId },
        );
      }

      // Log the planning mode creation.
      await runPlanningCreateSideEffect(
        "Planning create-task log entry failed",
        () => scopedStore.logEntry(task.id, "Created via Planning Mode", `Initial plan: ${(initialPlan ?? "").slice(0, 200)}`),
        { taskId: task.id, sessionId },
      );

      // Release any live in-memory planning runtime for this session, but
      // keep the persisted completed row so planning history can still list
      // and restore the summary after single-task creation.
      await runPlanningCreateSideEffect(
        "Planning create-task session release failed",
        () => releaseSession(sessionId),
        { taskId: task.id, sessionId },
      );

      res.status(201).json(task);
    } catch (err: unknown) {
      rethrowPlanningWorkflowCreateError(err, "Failed to create task", rethrowAsApiError);
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

      const session = await getSession(sessionId);
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
   * Body: { planningSessionId: string, subtasks: Array<{ id, title?, description?, suggestedSize?, priority?, dependsOn? }> }
   * Returns: { tasks: Task[] }
   */
  router.post("/planning/create-tasks", async (req, res) => {
    try {
      const { planningSessionId, subtasks, branch, baseBranch, branchSelection, branchAssignment, workflowId } = req.body as {
        planningSessionId?: string;
        subtasks?: Array<{
          id: string;
          title?: string;
          description?: string;
          suggestedSize?: "S" | "M" | "L";
          priority?: TaskPriority;
          dependsOn?: string[];
        }>;
        branch?: unknown;
        baseBranch?: unknown;
        branchSelection?: unknown;
        branchAssignment?: unknown;
        workflowId?: unknown;
      };

      if (!planningSessionId || typeof planningSessionId !== "string") {
        throw badRequest("planningSessionId is required");
      }

      if (!Array.isArray(subtasks) || subtasks.length === 0) {
        throw badRequest("subtasks must be a non-empty array");
      }

      if (workflowId !== undefined && workflowId !== null && typeof workflowId !== "string") {
        throw badRequest("workflowId must be a string or null");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { getSession, releaseSession, formatInterviewQA, mergePlanningSubtaskDrafts } = await import("../planning.js");

      const session = await getSession(planningSessionId);
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

      for (const item of subtasks) {
        if (!item || typeof item.id !== "string" || !item.id.trim()) {
          throw badRequest("Each subtask must include id");
        }
        if (item.title !== undefined && (typeof item.title !== "string" || !item.title.trim())) {
          throw badRequest("Each edited subtask title must be a non-empty string");
        }
        if (item.description !== undefined && typeof item.description !== "string") {
          throw badRequest("Each edited subtask description must be a string");
        }
        if (
          item.suggestedSize !== undefined
          && item.suggestedSize !== "S"
          && item.suggestedSize !== "M"
          && item.suggestedSize !== "L"
        ) {
          throw badRequest("Each edited subtask suggestedSize must be S, M, or L");
        }
        if (item.priority !== undefined && !isTaskPriority(item.priority)) {
          throw badRequest("Each subtask priority must be one of low, normal, high, urgent");
        }
        if (
          item.dependsOn !== undefined
          && (!Array.isArray(item.dependsOn) || item.dependsOn.some((dependency) => typeof dependency !== "string"))
        ) {
          throw badRequest("Each edited subtask dependsOn value must be an array of ids");
        }
      }

      let mergedSubtasks;
      try {
        mergedSubtasks = mergePlanningSubtaskDrafts(planningSessionId, subtasks);
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "Invalid planning subtask edits");
      }

      if (mergedSubtasks.length !== subtasks.length) {
        throw badRequest("Could not resolve planning subtasks for task creation");
      }

      const { branch: resolvedBranch, baseBranch: resolvedBaseBranch } =
        resolveBranchSelection(branchSelection, branch, baseBranch);
      // Planning subtasks have no strategy fallback; keep the historical shared default.
      const { mode: branchMode = "shared" } = resolveBranchAssignmentContext(branchAssignment);
      // Stamp the real BranchGroup id (BG-…) so listTasksByBranchGroup(group.id)
      // resolves members. The group is only ensured (and the id set) in shared
      // mode below. Non-shared members get NO groupId — stamping a synthetic
      // `planning:<id>` would let the legacy membership fallback sweep them into
      // a shared group later created for the same planning session.
      let planningGroupId: string | undefined;

      if (branchMode === "shared") {
        const settings = await scopedStore.getSettings();
        const settingsDefaultBranch =
          typeof settings.defaultBranch === "string" && settings.defaultBranch.trim().length > 0
            ? settings.defaultBranch
            : "main";
        const settingsAutoMerge = typeof settings.autoMerge === "boolean" ? settings.autoMerge : false;
        const branchGroupStore = scopedStore as { ensureBranchGroupForSource?: TaskStore["ensureBranchGroupForSource"] };
        const group = await branchGroupStore.ensureBranchGroupForSource?.("planning", planningSessionId, {
          branchName: resolvedBranch ?? resolvedBaseBranch ?? settingsDefaultBranch,
          autoMerge: session.autoMerge ?? settingsAutoMerge,
        });
        if (group) {
          planningGroupId = group.id;
        }
      }

      const planningBranchContext = {
        ...(planningGroupId ? { groupId: planningGroupId } : {}),
        source: "planning" as const,
        assignmentMode: branchMode,
        inheritedBaseBranch: resolvedBaseBranch,
      };

      const createdTasks = [] as Awaited<ReturnType<TaskStore["createTask"]>>[];
      const tempIdToTaskId = new Map<string, string>();

      for (const item of mergedSubtasks) {
        const { workingBranch: taskBranch } = resolveEntryPointBranchAssignment({
          assignmentMode: branchMode,
          resolvedBranch,
          taskSegment: item.title || item.id,
        });

        /*
        FNXC:Workflows 2026-07-05-00:00:
        FN-7611: do not hardcode column here. This route accepts an explicit workflowId
        (below), so a hardcoded "triage" would defeat that custom workflow's own intake
        column resolution. Omitting `column` lets the store resolve intake for the
        selected-or-default workflow (byte-identical "triage" for builtin:coding).
        */
        const task = await scopedStore.createTask({
          title: item.title.trim(),
          description: typeof item.description === "string" ? item.description.trim() : item.title.trim(),
          dependencies: undefined,
          priority: isTaskPriority(item.priority) ? item.priority : DEFAULT_TASK_PRIORITY,
          source: { sourceType: "api", sourceMetadata: { planningSessionId } },
          branch: taskBranch,
          baseBranch: resolvedBaseBranch,
          branchContext: planningBranchContext,
          /*
          FNXC:WorkflowSelection 2026-06-20-16:48:
          Multi-task Planning Mode creation must apply the selected workflow to every generated child so saved tasks do not jump to the main board first.
          */
          ...(workflowId !== undefined ? { workflowId: workflowId as string | null } : {}),
        });

        tempIdToTaskId.set(item.id, task.id);
        createdTasks.push(task);

        if (item.suggestedSize === "S" || item.suggestedSize === "M" || item.suggestedSize === "L") {
          await runPlanningCreateSideEffect(
            "Planning create-tasks size update failed",
            () => scopedStore.updateTask(task.id, { size: item.suggestedSize }),
            { taskId: task.id, planningSessionId },
          );
        }
      }

      for (let index = 0; index < mergedSubtasks.length; index++) {
        const item = mergedSubtasks[index]!;
        const created = createdTasks[index]!;
        const resolvedDependencies = Array.isArray(item.dependsOn)
          ? item.dependsOn.map((dep) => tempIdToTaskId.get(dep)).filter((dep): dep is string => Boolean(dep))
          : [];

        if (resolvedDependencies.length > 0) {
          await runPlanningCreateSideEffect(
            "Planning create-tasks dependency update failed",
            async () => {
              const updated = await scopedStore.updateTask(created.id, { dependencies: resolvedDependencies });
              createdTasks[index] = updated;
            },
            { taskId: created.id, planningSessionId },
          );
        }

        await runPlanningCreateSideEffect(
          "Planning create-tasks log entry failed",
          () => scopedStore.logEntry(created.id, "Created via Planning Mode (multi-task)", logDetails),
          { taskId: created.id, planningSessionId },
        );
      }

      // FNXC:PlanningMode 2026-07-13-00:00: release the live in-memory planning
      // runtime but KEEP the persisted completed row so the multi-task path
      // matches single-task create-task — completed planning sessions must remain
      // listable/restorable in the saved-sessions history. Using cleanupSession
      // here deleted the ai_sessions row, so a session that ran to completion and
      // created tasks vanished from history (GET /ai-sessions returned it no more).
      await runPlanningCreateSideEffect(
        "Planning create-tasks session release failed",
        () => releaseSession(planningSessionId),
        { planningSessionId },
      );

      res.status(201).json({ tasks: createdTasks });
    } catch (err: unknown) {
      rethrowPlanningWorkflowCreateError(err, "Failed to create tasks from planning", rethrowAsApiError);
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
      const session = await getSession(sessionId);
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

      // First-connect catch-up should replay buffered thinking chunks so the
      // loading view can stream immediately even if the client subscribed late.
      if (lastEventId === undefined) {
        const bufferedThinking = planningStreamManager
          .getBufferedEvents(sessionId, 0)
          .filter((event) => event.event === "thinking");
        if (!replayBufferedSSE(res, bufferedThinking)) {
          res.end();
          return;
        }
      }

      // Catch-up for awaiting_input sessions: emit current question immediately
      // so late subscribers don't miss the transition and see the question without delay.
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

      planningStreamManager.consumeInitialTurn(sessionId)?.();

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
      "POST /planning/:sessionId/back",
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
