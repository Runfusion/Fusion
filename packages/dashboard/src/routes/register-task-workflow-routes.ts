import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import type { TaskStore, Task, TaskDetail, Column } from "@fusion/core";
import { COLUMNS, VALID_TRANSITIONS } from "@fusion/core";
import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

interface TaskWorkflowRouteDeps {
  runtimeLogger: { error: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };
  upload: { single: (name: string) => unknown };
  taskDetailActivityLogLimit: number;
  validateOptionalModelField: (value: unknown, name: string) => string | undefined;
  normalizeModelSelectionPair: (provider: string | undefined, modelId: string | undefined) => { provider?: string | null; modelId?: string | null };
  runGitCommand: (args: string[], cwd: string, timeoutMs: number) => Promise<string>;
  resolveDiffBase: (task: Task, cwd: string) => Promise<string | undefined>;
  trimTaskDetailActivityLog: (task: TaskDetail) => TaskDetail;
  triggerCommentWakeForAssignedAgent: (scopedStore: TaskStore, task: Task, wake: { triggeringCommentType: "steering" | "task" | "pr"; triggeringCommentIds?: string[]; triggerDetail: string }) => Promise<void>;
}

export function registerTaskWorkflowRoutes(ctx: ApiRoutesContext, deps: TaskWorkflowRouteDeps): void {
  const { router, options, getProjectContext, rethrowAsApiError } = ctx;
  const {
    runtimeLogger,
    upload,
    taskDetailActivityLogLimit,
    validateOptionalModelField,
    normalizeModelSelectionPair,
    runGitCommand,
    resolveDiffBase,
    trimTaskDetailActivityLog,
    triggerCommentWakeForAssignedAgent,
  } = deps;
  const TASK_DETAIL_ACTIVITY_LOG_LIMIT = taskDetailActivityLogLimit;

  // List all tasks
  router.get("/tasks", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
      const offset = typeof req.query.offset === "string" ? Number.parseInt(req.query.offset, 10) : undefined;
      const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
      const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";

      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        throw badRequest("limit must be a non-negative integer");
      }

      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        throw badRequest("offset must be a non-negative integer");
      }

      let tasks;
      if (q && q.length > 0) {
        tasks = await scopedStore.searchTasks(q, { limit, offset, slim: true, includeArchived });
      } else {
        // Board-view list: omit the heavy agent log payload and exclude
        // archived tasks unless explicitly requested. Full task detail still loads via
        // GET /api/tasks/:id. Without this, every dashboard load shipped tens of MB of agent logs.
        tasks = await scopedStore.listTasks({ limit, offset, slim: true, includeArchived });
      }
      res.json(tasks);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Create task
  router.post("/tasks", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const {
        title,
        description,
        column,
        dependencies,
        breakIntoSubtasks,
        enabledWorkflowSteps,
        modelPresetId,
        modelProvider,
        modelId,
        validatorModelProvider,
        validatorModelId,
        planningModelProvider,
        planningModelId,
        thinkingLevel,
        reviewLevel,
        executionMode,
      } = req.body;
      if (!description || typeof description !== "string") {
        throw badRequest("description is required");
      }
      if (breakIntoSubtasks !== undefined && typeof breakIntoSubtasks !== "boolean") {
        throw badRequest("breakIntoSubtasks must be a boolean");
      }

      const validatedModelProvider = validateOptionalModelField(modelProvider, "modelProvider");
      const validatedModelId = validateOptionalModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateOptionalModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateOptionalModelField(validatorModelId, "validatorModelId");
      const validatedPlanningModelProvider = validateOptionalModelField(planningModelProvider, "planningModelProvider");
      const validatedPlanningModelId = validateOptionalModelField(planningModelId, "planningModelId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
      if (thinkingLevel !== undefined && thinkingLevel !== null && !validThinkingLevels.includes(thinkingLevel)) {
        throw badRequest(`thinkingLevel must be one of: ${validThinkingLevels.join(", ")}`);
      }

      // Validate reviewLevel if provided (must be integer 0-3)
      if (reviewLevel !== undefined && reviewLevel !== null) {
        if (typeof reviewLevel !== "number" || !Number.isInteger(reviewLevel) || reviewLevel < 0 || reviewLevel > 3) {
          throw badRequest("reviewLevel must be an integer between 0 and 3");
        }
      }

      // Validate executionMode if provided (must be "standard" or "fast")
      const validExecutionModes = ["standard", "fast"];
      if (executionMode !== undefined && executionMode !== null && !validExecutionModes.includes(executionMode)) {
        throw badRequest(`executionMode must be one of: ${validExecutionModes.join(", ")}`);
      }

      const executorModel = normalizeModelSelectionPair(validatedModelProvider, validatedModelId);
      const validatorModel = normalizeModelSelectionPair(validatedValidatorModelProvider, validatedValidatorModelId);
      const planningModel = normalizeModelSelectionPair(validatedPlanningModelProvider, validatedPlanningModelId);

      // Validate enabledWorkflowSteps if provided
      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          throw badRequest("enabledWorkflowSteps must be an array of strings");
        }
      }

      // Check for summarize flag in request
      const summarize = req.body.summarize === true;

      // Get settings for auto-summarization (fast path — skips expensive workflow steps query)
      const settings = await scopedStore.getSettingsFast();

      // Create onSummarize callback if summarization is enabled
      const onSummarize = (summarize || settings.autoSummarizeTitles)
        ? async (desc: string): Promise<string | null> => {
            try {
              const { summarizeTitle } = await import("@fusion/core");

              // Resolve model selection hierarchy for summarization:
              // 1. Project titleSummarizer override (titleSummarizerProvider + titleSummarizerModelId)
              // 2. Global summarization lane (titleSummarizerGlobalProvider + titleSummarizerGlobalModelId)
              // 3. Default pair (defaultProvider + defaultModelId)
              const resolvedProvider =
                (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerProvider : undefined) ||
                (settings.titleSummarizerGlobalProvider && settings.titleSummarizerGlobalModelId ? settings.titleSummarizerGlobalProvider : undefined) ||
                (settings.defaultProvider && settings.defaultModelId ? settings.defaultProvider : undefined);

              const resolvedModelId =
                (settings.titleSummarizerProvider && settings.titleSummarizerModelId ? settings.titleSummarizerModelId : undefined) ||
                (settings.titleSummarizerGlobalProvider && settings.titleSummarizerGlobalModelId ? settings.titleSummarizerGlobalModelId : undefined) ||
                (settings.defaultProvider && settings.defaultModelId ? settings.defaultModelId : undefined);

              return await summarizeTitle(desc, scopedStore.getRootDir(), resolvedProvider, resolvedModelId);
            } catch (err) {
              // Log the full error so server logs show what went wrong
              const errorMessage = err instanceof Error ? err.message : String(err);
              runtimeLogger.error(`Title summarization failed: ${errorMessage}`, {
                error: errorMessage,
              });
              // Return null on error so task creation continues without title
              return null;
            }
          }
        : undefined;

      const task = await scopedStore.createTask(
        {
          title,
          description,
          column,
          dependencies,
          breakIntoSubtasks,
          enabledWorkflowSteps,
          modelPresetId: validateOptionalModelField(modelPresetId, "modelPresetId"),
          modelProvider: executorModel.provider ?? undefined,
          modelId: executorModel.modelId ?? undefined,
          validatorModelProvider: validatorModel.provider ?? undefined,
          validatorModelId: validatorModel.modelId ?? undefined,
          planningModelProvider: planningModel.provider ?? undefined,
          planningModelId: planningModel.modelId ?? undefined,
          thinkingLevel: thinkingLevel || undefined,
          summarize,
          reviewLevel: reviewLevel ?? undefined,
          executionMode: executionMode || undefined,
        },
        { onSummarize, settings: { autoSummarizeTitles: settings.autoSummarizeTitles } }
      );
      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Move task to column
  router.post("/tasks/:id/move", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { column } = req.body;
      if (!column || !COLUMNS.includes(column as Column)) {
        throw badRequest(`Invalid column. Must be one of: ${COLUMNS.join(", ")}`);
      }
      const task = await scopedStore.moveTask(req.params.id, column as Column);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Merge task (in-review → done, merges branch + cleans worktree)
  // Uses AI merge handler if provided, falls back to store.mergeTask
  router.post("/tasks/:id/merge", async (req, res) => {
    try {
      const { store: scopedStore, engine } = await getProjectContext(req);
      const merge = engine
        ? (id: string) => engine.onMerge(id)
        : options?.onMerge ?? ((id: string) => scopedStore.mergeTask(id));
      const result = await merge(req.params.id);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Cannot merge") ? 400
        : (err instanceof Error ? err.message : String(err)).includes("conflict") ? 409
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Retry failed, stuck-killed, or stranded triage/specification task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const retrySpecification =
        task.column === "triage" &&
        (task.status === "failed" ||
          task.status === "specifying" ||
          task.status === "needs-respecify" ||
          (task.stuckKillCount ?? 0) > 0);
      if (task.status !== "failed" && task.status !== "stuck-killed" && !retrySpecification) {
        throw badRequest(`Task is not in a retryable state (current status: ${task.status || 'none'})`);
      }
      await scopedStore.updateTask(req.params.id, {
        status: retrySpecification ? "needs-respecify" : null,
        error: null,
        worktree: null,
        branch: null,
        baseBranch: null,
        baseCommitSha: null,
        stuckKillCount: 0,
        recoveryRetryCount: null,
        nextRecoveryAt: null,
      });

      if (retrySpecification) {
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });
        await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (specification retry budget reset)");
        const updated = await scopedStore.getTask(req.params.id);
        res.json(updated);
        return;
      }

      // Reset steps if the branch has no unique commits (work was lost with worktree)
      const completedSteps = task.steps.filter(
        (s: { status: string }) => s.status === "done" || s.status === "in-progress",
      );
      if (completedSteps.length > 0) {
        const branchName = task.branch || `fusion/${task.id.toLowerCase()}`;
        try {
          const rootDir = scopedStore.getRootDir();
          const mergeBase = (await runGitCommand(["merge-base", branchName, "HEAD"], rootDir, 5000)).trim();
          const branchHead = (await runGitCommand(["rev-parse", branchName], rootDir, 5000)).trim();

          if (mergeBase === branchHead) {
            for (let i = 0; i < task.steps.length; i++) {
              if (task.steps[i].status === "done" || task.steps[i].status === "in-progress") {
                await scopedStore.updateStep(req.params.id, i, "pending");
              }
            }
            await scopedStore.logEntry(
              req.params.id,
              `Reset ${completedSteps.length} step(s) to pending — branch had no commits (uncommitted work lost)`,
            );
          }
        } catch {
          // Branch may not exist — non-fatal, steps keep their status
        }
      }

      await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (stuck kill budget reset)");
      const updated = await scopedStore.moveTask(req.params.id, "todo");
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Duplicate task
  router.post("/tasks/:id/duplicate", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const newTask = await scopedStore.duplicateTask(req.params.id);
      res.status(201).json(newTask);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Create refinement task from a completed or in-review task
  router.post("/tasks/:id/refine", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        throw badRequest("feedback is required and must be a string");
      }
      // Trim before checking length to catch whitespace-only input
      const trimmedFeedback = feedback.trim();
      if (trimmedFeedback.length === 0 || trimmedFeedback.length > 2000) {
        throw badRequest("feedback must be between 1 and 2000 characters");
      }

      const refinedTask = await scopedStore.refineTask(req.params.id, trimmedFeedback);
      await scopedStore.logEntry(req.params.id, "Refinement requested", trimmedFeedback);
      res.status(201).json(refinedTask);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("must be in 'done' or 'in-review'") ? 400
        : (err instanceof Error ? err.message : String(err)).includes("Feedback is required") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Archive task (done → archived)
  router.post("/tasks/:id/archive", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.archiveTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be in") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Unarchive task (archived → done)
  router.post("/tasks/:id/unarchive", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.unarchiveTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be in") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Archive all done tasks
  router.post("/tasks/archive-all-done", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const archived = await scopedStore.archiveAllDone();
      res.json({ archived });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/tasks/batch-update-models
   * Batch update AI model configuration for multiple tasks.
   * Body: { taskIds: string[], modelProvider?: string | null, modelId?: string | null, validatorModelProvider?: string | null, validatorModelId?: string | null, planningModelProvider?: string | null, planningModelId?: string | null }
   * Returns: { updated: Task[], count: number }
   */
  router.post("/tasks/batch-update-models", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { taskIds, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId } = req.body;

      // Validate taskIds
      if (!Array.isArray(taskIds)) {
        throw badRequest("taskIds must be an array");
      }
      if (taskIds.length === 0) {
        throw badRequest("taskIds must contain at least one task ID");
      }
      if (taskIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
        throw badRequest("taskIds must contain non-empty strings");
      }

      // Validate that at least one model field is being updated
      const hasExecutorModel = modelProvider !== undefined || modelId !== undefined;
      const hasValidatorModel = validatorModelProvider !== undefined || validatorModelId !== undefined;
      const hasPlanningModel = planningModelProvider !== undefined || planningModelId !== undefined;
      if (!hasExecutorModel && !hasValidatorModel && !hasPlanningModel) {
        throw badRequest("At least one model field must be provided");
      }

      // Validate model field pairs (both provider and modelId must be provided together or neither)
      const validateModelPair = (provider: unknown, modelIdValue: unknown, name: string): { provider?: string | null; modelId?: string | null } => {
        if (provider === undefined && modelIdValue === undefined) {
          return { provider: undefined, modelId: undefined };
        }
        if ((provider !== undefined && modelIdValue === undefined) || (provider === undefined && modelIdValue !== undefined)) {
          throw new Error(`${name} must include both provider and modelId or neither`);
        }
        if (provider !== null && typeof provider !== "string") {
          throw new Error(`${name} provider must be a string or null`);
        }
        if (modelIdValue !== null && typeof modelIdValue !== "string") {
          throw new Error(`${name} modelId must be a string or null`);
        }
        return { provider: provider as string | null, modelId: modelIdValue as string | null };
      };

      let validatedExecutor: { provider?: string | null; modelId?: string | null };
      let validatedValidator: { provider?: string | null; modelId?: string | null };
      let validatedPlanning: { provider?: string | null; modelId?: string | null };

      try {
        validatedExecutor = validateModelPair(modelProvider, modelId, "Executor model");
        validatedValidator = validateModelPair(validatorModelProvider, validatorModelId, "Validator model");
        validatedPlanning = validateModelPair(planningModelProvider, planningModelId, "Planning model");
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          throw err;
        }
        throw badRequest(err instanceof Error ? err.message : String(err));
      }

      // Verify all tasks exist
      const tasksById = new Map<string, Awaited<ReturnType<TaskStore["getTask"]>>>();
      for (const taskId of taskIds) {
        try {
          const task = await scopedStore.getTask(taskId);
          tasksById.set(taskId, task);
        } catch (err: unknown) {
          if (err instanceof ApiError) {
            throw err;
          }
          if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
            throw notFound(`Task ${taskId} not found`);
          }
          throw err;
        }
      }

      // Build update payload (only include fields that were explicitly provided)
      const updates: { modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null } = {};
      if (validatedExecutor.provider !== undefined) {
        updates.modelProvider = validatedExecutor.provider;
      }
      if (validatedExecutor.modelId !== undefined) {
        updates.modelId = validatedExecutor.modelId;
      }
      if (validatedValidator.provider !== undefined) {
        updates.validatorModelProvider = validatedValidator.provider;
      }
      if (validatedValidator.modelId !== undefined) {
        updates.validatorModelId = validatedValidator.modelId;
      }
      if (validatedPlanning.provider !== undefined) {
        updates.planningModelProvider = validatedPlanning.provider;
      }
      if (validatedPlanning.modelId !== undefined) {
        updates.planningModelId = validatedPlanning.modelId;
      }

      // Update all tasks in parallel
      const updatePromises = taskIds.map(async (taskId) => {
        try {
          const updated = await scopedStore.updateTask(taskId, updates);
          return { success: true, task: updated };
        } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
          runtimeLogger.error(`Failed to update task ${taskId}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          const success = false;
          return { success, taskId, error: err instanceof Error ? err.message : String(err) };
        }
      });

      const results = await Promise.all(updatePromises);

      // Collect successful updates
      const updated: Task[] = [];
      const errors: Array<{ taskId: string; error: string | undefined }> = [];

      for (const result of results) {
        if (result.success && "task" in result && result.task) {
          updated.push(result.task);
        } else if (!result.success) {
          errors.push({ taskId: result.taskId, error: result.error });
        }
      }

      // Log errors but don't fail the entire request
      if (errors.length > 0) {
        runtimeLogger.error(`${errors.length} tasks failed to update`, { errors });
      }

      res.json({ updated, count: updated.length });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err, "Failed to batch update models");
    }
  });

  // Upload attachment
  router.post("/tasks/:id/attachments", upload.single("file") as import("express").RequestHandler, async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      if (!req.file) {
        throw badRequest("No file provided");
      }
      const attachment = await scopedStore.addAttachment(
        req.params.id as string,
        req.file.originalname,
        req.file.buffer,
        req.file.mimetype,
      );
      res.status(201).json(attachment);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("Invalid mime type") || (err instanceof Error ? err.message : String(err)).includes("File too large") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Download attachment
  router.get("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { path, mimeType } = await scopedStore.getAttachment(req.params.id, req.params.filename);
      res.setHeader("Content-Type", mimeType);
      createReadStream(path).pipe(res);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Attachment not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Delete attachment
  router.delete("/tasks/:id/attachments/:filename", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.deleteAttachment(req.params.id, req.params.filename);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound("Attachment not found");
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Get historical agent logs for a task.
  // Per-entry text and detail fields are returned in full — no truncation.
  // The 500-entry cap (MAX_LOG_ENTRIES) is a client-side whole-list limit.
  // When limit is provided, includes X-Total-Count and X-Has-More headers for pagination.
  router.get("/tasks/:id/logs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const limit = typeof req.query.limit === "string"
        ? Number.parseInt(req.query.limit, 10)
        : undefined;
      const offset = typeof req.query.offset === "string"
        ? Number.parseInt(req.query.offset, 10)
        : undefined;

      // Only include options object when we have explicit parameters
      const options: { limit?: number; offset?: number } | undefined =
        limit !== undefined && Number.isFinite(limit)
          ? { limit, ...(offset !== undefined && Number.isFinite(offset) ? { offset } : {}) }
          : undefined;

      const logs = await scopedStore.getAgentLogs(req.params.id, options);

      // Include pagination headers for bounded reads, including the initial page.
      // This enables the frontend to show Load More before an offset is present.
      if (limit !== undefined && Number.isFinite(limit)) {
        const total = await scopedStore.getAgentLogCount(req.params.id);
        res.setHeader("X-Total-Count", String(total));

        const effectiveOffset = offset !== undefined && Number.isFinite(offset) ? offset : 0;
        const hasMore = total > (effectiveOffset + logs.length);
        res.setHeader("X-Has-More", hasMore ? "true" : "false");
      }

      res.json(logs);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/tasks/:id/workflow-results
   * Get workflow step execution results for a task.
   * Returns: WorkflowStepResult[]
   */
  router.get("/tasks/:id/workflow-results", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.workflowStepResults || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // Get single task with prompt content
  router.get("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id, {
        activityLogLimit: TASK_DETAIL_ACTIVITY_LOG_LIMIT,
      });
      res.json(trimTaskDetailActivityLog(task));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // ENOENT means the task directory/file genuinely doesn't exist → 404.
      // Any other error (e.g. JSON parse failure from a concurrent partial write,
      // or a transient FS error) should surface as 500 so clients can retry.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      } else {
        rethrowAsApiError(err, "Internal server error");
      }
    }
  });

  // Pause task
  router.post("/tasks/:id/pause", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.pauseTask(req.params.id, true);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Unpause task
  router.post("/tasks/:id/unpause", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.pauseTask(req.params.id, false);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Approve plan for a task in awaiting-approval status
  router.post("/tasks/:id/approve-plan", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column to approve plan");
      }
      if (task.status !== "awaiting-approval") {
        throw badRequest("Task must have status 'awaiting-approval' to approve plan");
      }

      // Log the approval
      await scopedStore.logEntry(task.id, "Plan approved by user");

      // Move to todo and clear status
      const updated = await scopedStore.moveTask(task.id, "todo");
      await scopedStore.updateTask(task.id, { status: undefined });

      res.json({ ...updated, status: undefined });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Reject plan for a task in awaiting-approval status
  router.post("/tasks/:id/reject-plan", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      // Verify task is in triage column with awaiting-approval status
      if (task.column !== "triage") {
        throw badRequest("Task must be in 'triage' column to reject plan");
      }
      if (task.status !== "awaiting-approval") {
        throw badRequest("Task must have status 'awaiting-approval' to reject plan");
      }

      // Log the rejection
      await scopedStore.logEntry(task.id, "Plan rejected by user", "Specification will be regenerated");

      // Clear status to return to normal triage state
      await scopedStore.updateTask(task.id, { status: undefined });

      // Remove PROMPT.md to force regeneration
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      const updated = await scopedStore.getTask(task.id);
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.get("/tasks/:id/comments", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      res.json(task.comments || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.post("/tasks/:id/comments", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text, author } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      if (author !== undefined && typeof author !== "string") {
        throw badRequest("author must be a string");
      }
      const task = await scopedStore.addTaskComment(req.params.id, text, author?.trim() || "user");

      const newCommentId = task.comments?.at(-1)?.id;
      void triggerCommentWakeForAssignedAgent(scopedStore, task, {
        triggeringCommentType: "task",
        triggeringCommentIds: newCommentId ? [newCommentId] : undefined,
        triggerDetail: "task-comment",
      }).catch((error) => {
        runtimeLogger.warn(
          `failed to trigger task-comment heartbeat for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.patch("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      const task = await scopedStore.updateTaskComment(req.params.id, req.params.commentId, text);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("not found") ? 404
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  router.delete("/tasks/:id/comments/:commentId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.deleteTaskComment(req.params.id, req.params.commentId);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("not found") ? 404
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // ── Task Document Routes ──────────────────────────────────────────────────

  // Key validation regex: alphanumeric, hyphens, underscores, 1-64 chars
  const DOCUMENT_KEY_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

  // GET /tasks/:id/documents — List all documents for a task
  router.get("/tasks/:id/documents", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const documents = await scopedStore.getTaskDocuments(req.params.id);
      res.json(documents);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /tasks/:id/documents/:key — Get latest revision of a specific document
  router.get("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const document = await scopedStore.getTaskDocument(req.params.id, req.params.key);
      if (!document) {
        throw new ApiError(404, "Document not found");
      }
      res.json(document);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /tasks/:id/documents/:key/revisions — List all revisions for a document
  router.get("/tasks/:id/documents/:key/revisions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const revisions = await scopedStore.getTaskDocumentRevisions(req.params.id, req.params.key);
      res.json(revisions);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      // Return empty array if document doesn't exist (not an error)
      res.json([]);
    }
  });

  // PUT /tasks/:id/documents/:key — Create or update a document (optimistic revision)
  router.put("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Validate key format
      if (!DOCUMENT_KEY_REGEX.test(req.params.key)) {
        throw badRequest("Invalid document key. Must be 1-64 alphanumeric characters, hyphens, or underscores.");
      }

      const { content, author, metadata } = req.body;

      // Validate content
      if (content === undefined || content === null) {
        throw badRequest("content is required");
      }
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }
      if (content.length < 1 || content.length > 100000) {
        throw badRequest("content must be between 1 and 100000 characters");
      }

      // Validate author (optional, defaults to "user")
      if (author !== undefined && typeof author !== "string") {
        throw badRequest("author must be a string");
      }

      // Validate metadata (optional)
      if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
        throw badRequest("metadata must be an object");
      }

      const document = await scopedStore.upsertTaskDocument(req.params.id, {
        key: req.params.key,
        content,
        author: author?.trim() || "user",
        metadata: metadata as Record<string, unknown> | undefined,
      });

      // Return 201 for new documents (revision === 1), 200 for updates
      const status = document.revision === 1 ? 201 : 200;
      res.status(status).json(document);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // DELETE /tasks/:id/documents/:key — Delete a document and all its revisions
  router.delete("/tasks/:id/documents/:key", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      await scopedStore.deleteTaskDocument(req.params.id, req.params.key);
      res.status(204).send();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("not found") ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // GET /documents — List all documents across all tasks
  router.get("/documents", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Parse query parameters
      const { q, limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;

      // Validate limit
      let limit = 200;
      if (limitStr !== undefined) {
        const parsed = parseInt(limitStr, 10);
        if (isNaN(parsed) || parsed < 1) {
          throw badRequest("limit must be a positive integer");
        }
        limit = Math.min(parsed, 1000);
      }

      // Validate offset
      let offset = 0;
      if (offsetStr !== undefined) {
        const parsed = parseInt(offsetStr, 10);
        if (isNaN(parsed) || parsed < 0) {
          throw badRequest("offset must be a non-negative integer");
        }
        offset = parsed;
      }

      const documents = await scopedStore.getAllDocuments({
        searchQuery: q,
        limit,
        offset,
      });

      res.json(documents);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      throw new ApiError(500, err instanceof Error ? err.message : String(err));
    }
  });

  // Add steering comment to task
  router.post("/tasks/:id/steer", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { text } = req.body;
      if (!text || typeof text !== "string") {
        throw badRequest("text is required and must be a string");
      }
      if (text.length === 0 || text.length > 2000) {
        throw badRequest("text must be between 1 and 2000 characters");
      }
      const task = await scopedStore.addSteeringComment(req.params.id, text, "user");

      const newSteeringCommentId = task.steeringComments?.at(-1)?.id;
      void triggerCommentWakeForAssignedAgent(scopedStore, task, {
        triggeringCommentType: "steering",
        triggeringCommentIds: newSteeringCommentId ? [newSteeringCommentId] : undefined,
        triggerDetail: "steering-comment",
      }).catch((error) => {
        runtimeLogger.warn(
          `failed to trigger steering-comment heartbeat for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Request AI revision of task spec
  router.post("/tasks/:id/spec/revise", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { feedback } = req.body;
      if (!feedback || typeof feedback !== "string") {
        throw badRequest("feedback is required and must be a string");
      }
      if (feedback.length === 0 || feedback.length > 2000) {
        throw badRequest("feedback must be between 1 and 2000 characters");
      }

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // If task is already in triage, skip the transition check and moveTask.
      // Just reset for re-specification in place.
      if (task.column === "triage") {
        // Log the revision request
        await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

        // Remove the existing spec so re-specification starts from the task
        // description and feedback rather than revising stale PROMPT.md content.
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        // Update status to indicate needs re-specification
        await scopedStore.updateTask(task.id, { status: "needs-respecify" });

        const updated = await scopedStore.getTask(task.id);
        res.json(updated);
        return;
      }

      // Check if task can transition to triage
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
      if (!canTransition) {
        throw badRequest(
          `Cannot request spec revision for tasks in '${task.column}' column. Move task to 'todo' or 'in-progress' first.`,
        );
      }

      // Log the revision request
      await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

      // Move to triage for re-specification
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Remove the existing spec so re-specification starts from the task
      // description and feedback rather than revising stale PROMPT.md content.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs re-specification
      await scopedStore.updateTask(task.id, { status: "needs-respecify" });

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Rebuild task spec without feedback
  router.post("/tasks/:id/spec/rebuild", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Get current task state
      const task = await scopedStore.getTask(req.params.id);

      // If task is already in triage, skip the transition check and moveTask.
      // Just reset for re-specification in place.
      if (task.column === "triage") {
        // Log the rebuild request
        await scopedStore.logEntry(task.id, "Specification rebuild requested by user");

        // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
        // of asking triage to revise whatever was already on disk.
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        // Update status to indicate needs re-specification
        await scopedStore.updateTask(task.id, { status: "needs-respecify" });

        const updated = await scopedStore.getTask(task.id);
        res.json(updated);
        return;
      }

      // Check if task can transition to triage
      const canTransition = VALID_TRANSITIONS[task.column]?.includes("triage");
      if (!canTransition) {
        throw badRequest(`Cannot rebuild spec for tasks in '${task.column}' column. Move task to a valid column first.`);
      }

      // Log the rebuild request
      await scopedStore.logEntry(task.id, "Specification rebuild requested by user");

      // Move to triage for re-specification
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
      // of asking triage to revise whatever was already on disk.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs re-specification
      await scopedStore.updateTask(task.id, { status: "needs-respecify" });

      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const errorWithCode = err as NodeJS.ErrnoException;
      const status = errorWithCode.code === "ENOENT" ? 404
        : (err instanceof Error ? err.message : String(err)).includes("Invalid transition") ? 400
        : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Update task
  router.patch("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { title, description, prompt, dependencies, enabledWorkflowSteps, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId, thinkingLevel, assigneeUserId, reviewLevel, executionMode, sourceIssue } = req.body;
      const hasBodyField = (field: string) => Object.prototype.hasOwnProperty.call(req.body, field);

      // Validate model fields are strings or undefined/null
      const validateModelField = (value: unknown, name: string): string | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== "string") {
          throw new Error(`${name} must be a string`);
        }
        return value;
      };

      const validatedModelProvider = validateModelField(modelProvider, "modelProvider");
      const validatedModelId = validateModelField(modelId, "modelId");
      const validatedValidatorModelProvider = validateModelField(validatorModelProvider, "validatorModelProvider");
      const validatedValidatorModelId = validateModelField(validatorModelId, "validatorModelId");
      const validatedPlanningModelProvider = validateModelField(planningModelProvider, "planningModelProvider");
      const validatedPlanningModelId = validateModelField(planningModelId, "planningModelId");
      const validatedAssigneeUserId = validateModelField(assigneeUserId, "assigneeUserId");

      // Validate thinkingLevel if provided
      const validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
      if (thinkingLevel !== undefined && thinkingLevel !== null && !validThinkingLevels.includes(thinkingLevel)) {
        throw new Error(`thinkingLevel must be one of: ${validThinkingLevels.join(", ")}`);
      }

      // Validate reviewLevel if provided (must be integer 0-3)
      if (reviewLevel !== undefined && reviewLevel !== null) {
        if (typeof reviewLevel !== "number" || !Number.isInteger(reviewLevel) || reviewLevel < 0 || reviewLevel > 3) {
          throw new Error("reviewLevel must be an integer between 0 and 3");
        }
      }

      // Validate executionMode if provided (must be "standard" or "fast")
      const validExecutionModes = ["standard", "fast"];
      if (executionMode !== undefined && executionMode !== null && !validExecutionModes.includes(executionMode)) {
        throw new Error(`executionMode must be one of: ${validExecutionModes.join(", ")}`);
      }

      if (enabledWorkflowSteps !== undefined) {
        if (!Array.isArray(enabledWorkflowSteps) || !enabledWorkflowSteps.every((id: unknown) => typeof id === "string")) {
          throw new Error("enabledWorkflowSteps must be an array of strings");
        }
      }

      let validatedSourceIssue: import("@fusion/core").TaskSourceIssue | null | undefined;
      if (hasBodyField("sourceIssue")) {
        if (sourceIssue === null) {
          validatedSourceIssue = null;
        } else if (sourceIssue === undefined) {
          validatedSourceIssue = undefined;
        } else if (typeof sourceIssue === "object") {
          const candidate = sourceIssue as {
            provider?: unknown;
            repository?: unknown;
            externalIssueId?: unknown;
            issueNumber?: unknown;
            url?: unknown;
          };

          if (typeof candidate.provider !== "string" || candidate.provider.trim().length === 0) {
            throw new Error("sourceIssue.provider must be a non-empty string");
          }
          if (typeof candidate.repository !== "string" || candidate.repository.trim().length === 0) {
            throw new Error("sourceIssue.repository must be a non-empty string");
          }
          if (typeof candidate.externalIssueId !== "string" || candidate.externalIssueId.trim().length === 0) {
            throw new Error("sourceIssue.externalIssueId must be a non-empty string");
          }
          if (typeof candidate.issueNumber !== "number" || !Number.isFinite(candidate.issueNumber) || !Number.isInteger(candidate.issueNumber) || candidate.issueNumber <= 0) {
            throw new Error("sourceIssue.issueNumber must be a positive integer");
          }
          if (candidate.url !== undefined && candidate.url !== null && typeof candidate.url !== "string") {
            throw new Error("sourceIssue.url must be a string when provided");
          }

          validatedSourceIssue = {
            provider: candidate.provider.trim(),
            repository: candidate.repository.trim(),
            externalIssueId: candidate.externalIssueId.trim(),
            issueNumber: candidate.issueNumber,
            ...(typeof candidate.url === "string" && candidate.url.trim().length > 0 ? { url: candidate.url.trim() } : {}),
          };
        } else {
          throw new Error("sourceIssue must be an object or null");
        }
      }

      const updates: Parameters<typeof scopedStore.updateTask>[1] = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (prompt !== undefined) updates.prompt = prompt;
      if (dependencies !== undefined) updates.dependencies = dependencies;
      if (enabledWorkflowSteps !== undefined) updates.enabledWorkflowSteps = enabledWorkflowSteps;
      if (hasBodyField("modelProvider")) updates.modelProvider = validatedModelProvider;
      if (hasBodyField("modelId")) updates.modelId = validatedModelId;
      if (hasBodyField("validatorModelProvider")) updates.validatorModelProvider = validatedValidatorModelProvider;
      if (hasBodyField("validatorModelId")) updates.validatorModelId = validatedValidatorModelId;
      if (hasBodyField("planningModelProvider")) updates.planningModelProvider = validatedPlanningModelProvider;
      if (hasBodyField("planningModelId")) updates.planningModelId = validatedPlanningModelId;
      if (hasBodyField("thinkingLevel")) updates.thinkingLevel = thinkingLevel === null ? null : thinkingLevel;
      if (hasBodyField("assigneeUserId")) updates.assigneeUserId = validatedAssigneeUserId;
      if (hasBodyField("reviewLevel")) updates.reviewLevel = reviewLevel;
      if (hasBodyField("executionMode")) updates.executionMode = executionMode === null ? null : executionMode;
      if (hasBodyField("sourceIssue")) updates.sourceIssue = validatedSourceIssue === undefined ? undefined : validatedSourceIssue;

      const task = await scopedStore.updateTask(req.params.id, updates);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") || (err instanceof Error ? err.message : String(err)).includes("thinkingLevel must be one of") || (err instanceof Error ? err.message : String(err)).includes("reviewLevel must be an integer") || (err instanceof Error ? err.message : String(err)).includes("executionMode must be one of") || (err instanceof Error ? err.message : String(err)).includes("sourceIssue") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Assign or unassign a task to an explicit agent
  router.patch("/tasks/:id/assign", async (req, res) => {
    try {
      const { agentId } = req.body as { agentId?: string | null };
      if (agentId !== null && typeof agentId !== "string") {
        throw badRequest("agentId must be a string or null");
      }
      if (typeof agentId === "string" && agentId.trim().length === 0) {
        throw badRequest("agentId must be a non-empty string or null");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      if (typeof agentId === "string") {
        const agent = await agentStore.getAgent(agentId);
        if (!agent) {
          throw notFound("Agent not found");
        }
      }

      const task = await scopedStore.updateTask(req.params.id, {
        assignedAgentId: agentId === null ? null : agentId,
      });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Assign or unassign a task to a user (for review handoff)
  router.patch("/tasks/:id/assign-user", async (req, res) => {
    try {
      const { userId } = req.body as { userId?: string | null };
      if (userId !== null && typeof userId !== "string") {
        throw badRequest("userId must be a string or null");
      }
      if (typeof userId === "string" && userId.trim().length === 0) {
        throw badRequest("userId must be a non-empty string or null");
      }

      const { store: scopedStore } = await getProjectContext(req);

      // When assigning a user, also clear the awaiting-user-review status
      // so the task can proceed to merge
      const updates: Record<string, unknown> = {
        assigneeUserId: userId === null ? null : userId,
      };

      // Clear awaiting-user-review status when explicitly assigning a user
      if (userId !== null) {
        updates.status = null;
      }

      const task = await scopedStore.updateTask(req.params.id, updates as Parameters<typeof scopedStore.updateTask>[1]);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Accept review - clear assignee and awaiting-user-review status, keep in in-review
  router.post("/tasks/:id/accept-review", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Clear assignee and status to allow auto-merge to proceed
      const task = await scopedStore.updateTask(req.params.id, {
        assigneeUserId: null,
        status: null,
      });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Return task to agent - clear assignee and status, move to todo
  router.post("/tasks/:id/return-to-agent", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      // Clear assignee and status, move to todo so scheduler re-dispatches
      await scopedStore.updateTask(req.params.id, {
        assigneeUserId: null,
        status: null,
      });
      const task = await scopedStore.moveTask(req.params.id, "todo");
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  // Acquire checkout lease for a task
  router.post("/tasks/:id/checkout", async (req, res) => {
    try {
      const { agentId } = req.body ?? {};
      if (typeof agentId !== "string" || agentId.trim().length === 0) {
        throw badRequest("agentId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.checkoutTask(agentId, req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "CheckoutConflictError") {
        const checkoutErr = err as Error & { currentHolderId?: string; taskId?: string };
        res.status(409).json({
          error: "Task is already checked out",
          currentHolder: checkoutErr.currentHolderId,
          taskId: checkoutErr.taskId,
        });
        return;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Release checkout lease for a task
  router.post("/tasks/:id/release", async (req, res) => {
    try {
      const { agentId } = req.body ?? {};
      if (typeof agentId !== "string" || agentId.trim().length === 0) {
        throw badRequest("agentId is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.releaseTask(agentId, req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not the checkout holder")) {
        throw new ApiError(403, "Not the checkout holder");
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Force release checkout lease for a task
  router.post("/tasks/:id/force-release", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({
        rootDir: scopedStore.getFusionDir(),
        taskStore: scopedStore,
      });
      await agentStore.init();

      const task = await agentStore.forceReleaseTask(req.params.id);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
      rethrowAsApiError(err);
    }
  });

  // Get checkout lease state for a task
  router.get("/tasks/:id/checkout", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        throw notFound("Task not found");
      }

      res.json({
        checkedOutBy: task.checkedOutBy ?? null,
        checkedOutAt: task.checkedOutAt ?? null,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  // Delete task
  router.delete("/tasks/:id", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const removeDependencyReferences = req.query.removeDependencyReferences === "1"
        || req.query.removeDependencyReferences === "true";
      const task = await scopedStore.deleteTask(req.params.id, { removeDependencyReferences });
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const isTaskHasDependentsError =
        err instanceof Error
        && err.name === "TaskHasDependentsError"
        && Array.isArray((err as { dependentIds?: unknown }).dependentIds);

      if (isTaskHasDependentsError) {
        const dependentIds = (err as unknown as { dependentIds: string[] }).dependentIds;
        throw new ApiError(409, err instanceof Error ? err.message : "Task has dependents", {
          code: "TASK_HAS_DEPENDENTS",
          taskId: req.params.id,
          dependentIds,
        });
      }

      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/tasks/:id/diff
   * Fetch git diff for a task's changes.
   * Query: ?worktree=path
   * Returns: TaskDiff
   */
  router.get("/tasks/:id/diff", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      // Done tasks: diff from the squash commit's first parent.
      // The merger only performs squash merges, so sha^..sha contains exactly
      // this task's merged changes and excludes unrelated tasks merged in between.
      if (task.column === "done" && task.mergeDetails?.commitSha) {
        const rootDir = scopedStore.getRootDir();
        const sha = task.mergeDetails.commitSha;

        let mergeBase: string | undefined;

        try {
          mergeBase = (await runGitCommand(["rev-parse", `${sha}^`], rootDir, 5000)).trim();
        } catch {
          // Last resort: no diff available
          res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
          return;
        }

        const nameStatus = (await runGitCommand(["diff", "--name-status", `${mergeBase}..${sha}`], rootDir, 10000)).trim();

        const doneFiles: Array<{
          path: string;
          status: "added" | "modified" | "deleted";
          additions: number;
          deletions: number;
          patch: string;
        }> = [];

        for (const line of nameStatus.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const statusCode = parts[0] ?? "M";
          const filePath = parts[1] ?? "";
          if (!filePath) continue;

          let status: "added" | "modified" | "deleted" = "modified";
          if (statusCode.startsWith("A")) status = "added";
          else if (statusCode.startsWith("D")) status = "deleted";

          let patch = "";
          try {
            patch = await runGitCommand(["diff", `${mergeBase}..${sha}`, "--", filePath], rootDir, 10000);
          } catch { /* ignore */ }

          const additions = (patch.match(/^\+[^+]/gm) || []).length;
          const deletions = (patch.match(/^-[^-]/gm) || []).length;
          doneFiles.push({ path: filePath, status, additions, deletions, patch });
        }

        const doneStats = {
          filesChanged: doneFiles.length,
          additions: doneFiles.reduce((s, f) => s + f.additions, 0),
          deletions: doneFiles.reduce((s, f) => s + f.deletions, 0),
        };

        res.json({ files: doneFiles, stats: doneStats });
        return;
      }

      // Done tasks without a commit SHA: return safe, deterministic response.
      // Do NOT fall through to the worktree-based diff logic, which would use
      // the repo root as cwd and return an inflated repository-wide diff.
      if (task.column === "done") {
        const md = task.mergeDetails;
        res.json({
          files: [],
          stats: {
            filesChanged: md?.filesChanged ?? 0,
            additions: md?.insertions ?? 0,
            deletions: md?.deletions ?? 0,
          },
        });
        return;
      }

      const worktree = typeof req.query.worktree === "string" ? req.query.worktree : undefined;
      const resolvedWorktree = worktree || task.worktree;

      // Check worktree existence asynchronously to avoid blocking event loop
      if (!resolvedWorktree) {
        res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
        return;
      }
      let worktreeExists = false;
      try {
        await access(resolvedWorktree);
        worktreeExists = true;
      } catch {
        worktreeExists = false;
      }
      if (!worktreeExists) {
        res.json({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } });
        return;
      }
      const cwd = resolvedWorktree;

      // Use resolveDiffBase for consistent diff base across all endpoints
      const diffBase = await resolveDiffBase(task, cwd);
      const diffRange = diffBase ? `${diffBase}..HEAD` : "HEAD";

      // Get list of changed files — include committed, staged, unstaged, and untracked
      const fileMap = new Map<string, string>();

      if (diffBase) {
        try {
          const committedOutput = (await runGitCommand(["diff", "--name-status", `${diffBase}..HEAD`], cwd, 10000)).trim();
          for (const line of committedOutput.split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            fileMap.set(parts[1] ?? "", parts[0] ?? "M");
          }
        } catch {
          // committed diff failed
        }
      }

      // Staged changes (in git index)
      try {
        const stagedOutput = (await runGitCommand(["diff", "--cached", "--name-status"], cwd, 10000)).trim();
        for (const line of stagedOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          // Use staged status (don't overwrite committed status)
          const filePath = parts[1] ?? "";
          if (filePath && !fileMap.has(filePath)) {
            fileMap.set(filePath, parts[0] ?? "M");
          }
        }
      } catch {
        // staged diff failed
      }

      try {
        const workingTreeOutput = (await runGitCommand(["diff", "--name-status"], cwd, 10000)).trim();
        for (const line of workingTreeOutput.split("\n").filter(Boolean)) {
          const parts = line.split("\t");
          const filePath = parts[1] ?? "";
          // Unstaged changes only affect files not already in map (to avoid overwrite)
          if (filePath && !fileMap.has(filePath)) {
            fileMap.set(filePath, parts[0] ?? "M");
          }
        }
      } catch {
        // working tree diff failed
      }

      // Untracked files (new files not yet staged)
      try {
        const untrackedOutput = (await runGitCommand(["ls-files", "--others", "--exclude-standard"], cwd, 10000)).trim();
        for (const line of untrackedOutput.split("\n").filter(Boolean)) {
          // Mark as untracked with special status "U" - will be converted to "added"
          fileMap.set(line, "U");
        }
      } catch {
        // untracked listing failed
      }

      const files: Array<{
        path: string;
        status: "added" | "modified" | "deleted";
        additions: number;
        deletions: number;
        patch: string;
      }> = [];

      for (const [filePath, statusCode] of fileMap) {
        if (!filePath) continue;

        let status: "added" | "modified" | "deleted";
        if (statusCode.startsWith("A") || statusCode === "U") status = "added";
        else if (statusCode.startsWith("D")) status = "deleted";
        else status = "modified";

        // Get patch for this file
        let patch = "";
        try {
          // For untracked files, generate synthetic diff against /dev/null
          if (statusCode === "U") {
            patch = await runGitCommand(["diff", "--no-index", "/dev/null", filePath], cwd, 10000).catch(() => "");
          } else {
            patch = await runGitCommand(["diff", diffRange, "--", filePath], cwd, 10000);
          }
        } catch {
          // Ignore errors for individual files
        }

        const additions = (patch.match(/^\+[^+]/gm) || []).length;
        const deletions = (patch.match(/^-[^-]/gm) || []).length;

        files.push({ path: filePath, status, additions, deletions, patch });
      }

      const stats = {
        filesChanged: files.length,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      };

      res.json({ files, stats });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

}
