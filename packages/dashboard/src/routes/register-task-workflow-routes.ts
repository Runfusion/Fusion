import { createReadStream } from "node:fs";
import type { TaskStore, Task, TaskDetail, Column, TaskReviewData, TaskReviewItem, TaskReviewSummary } from "@fusion/core";
import {
  COLUMNS,
  TASK_PRIORITIES,
  VALID_TRANSITIONS,
  buildMeshReplicatedTaskCreatePayload,
  isTaskPriority,
  resolveTitleSummarizerSettingsModel,
  toReplicatedCreateInput,
  validateNodeOverrideChange,
  canAgentTakeImplementationTask,
  formatRoleMismatchReason,
  getCurrentRepo,
} from "@fusion/core";
import { GitHubClient } from "../github.js";
import { maybeCreateTrackingIssue } from "../github-tracking.js";
import { parseGitHubBadgeUrl } from "./register-git-github.js";
import { planTaskWorktreePath } from "@fusion/engine";
import { ApiError, badRequest, conflict, notFound } from "../api-error.js";
import { fetchFromRemoteNode } from "./register-settings-sync-helpers.js";
import type { ApiRoutesContext } from "./types.js";
import { resolveBranchSelection } from "./branch-selection.js";

const REVIEW_BLOCK_RE = /##\s+(Code|Plan)\s+Review:[\s\S]*?(?=\n##\s+(?:Code|Plan)\s+Review:|$)/gi;
const REVIEW_VERDICT_RE = /###\s+Verdict:\s*(APPROVE|REVISE|RETHINK|UNAVAILABLE)\b/i;
const REVIEW_STEP_RE = /^(plan|code) review Step (\d+): (APPROVE|REVISE|RETHINK|UNAVAILABLE)\b/i;

function buildReviewerAgentItemId(input: { index: number; reviewType: "plan" | "code"; step?: number; verdict?: string; createdAt?: string }): string {
  const stepPart = input.step ? `step-${input.step}` : "step-na";
  const verdictPart = (input.verdict ?? "unknown").toLowerCase();
  const timePart = (input.createdAt ?? "na").replace(/[:.]/g, "-");
  return `reviewer-${input.reviewType}-${stepPart}-${verdictPart}-${timePart}-${input.index + 1}`;
}

async function buildDirectTaskReviewData(task: Task, store: TaskStore): Promise<TaskReviewData> {
  const agentLogs = await store.getAgentLogs(task.id);
  const reviewerText = agentLogs.filter((entry) => entry.agent === "reviewer" && entry.type === "text").map((entry) => entry.text).join("\n");
  const fallbackLogs = (task.log ?? []).filter((entry) => REVIEW_STEP_RE.test(entry.action));

  const items: TaskReviewItem[] = [];
  const blocks = reviewerText.match(REVIEW_BLOCK_RE) ?? [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] ?? "";
    const typeMatch = block.match(/##\s+(Code|Plan)\s+Review:/i);
    const reviewType = typeMatch?.[1]?.toLowerCase() === "plan" ? "plan" : "code";
    const verdict = block.match(REVIEW_VERDICT_RE)?.[1]?.toUpperCase();
    const fallback = fallbackLogs[index];
    const createdAt = fallback?.timestamp ?? task.updatedAt;
    items.push({
      itemId: buildReviewerAgentItemId({ index, reviewType, verdict, createdAt }),
      sourceMode: "reviewer-agent",
      title: `${reviewType} review ${verdict ?? "feedback"}`,
      body: block.trim(),
      author: "reviewer-agent",
      createdAt,
      updatedAt: createdAt,
      reviewState: verdict ?? null,
      progressStatus: null,
    });
  }

  if (items.length === 0) {
    fallbackLogs.forEach((entry, index) => {
      const match = entry.action.match(REVIEW_STEP_RE);
      const reviewType = match?.[1]?.toLowerCase() === "plan" ? "plan" : "code";
      const verdict = match?.[3]?.toUpperCase();
      items.push({
        itemId: buildReviewerAgentItemId({ index, reviewType, step: match?.[2] ? Number.parseInt(match[2], 10) : undefined, verdict, createdAt: entry.timestamp }),
        sourceMode: "reviewer-agent",
        title: `${reviewType} review ${verdict ?? "feedback"}`,
        body: entry.action,
        author: "reviewer-agent",
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
        reviewState: verdict ?? null,
        progressStatus: null,
      });
    });
  }

  const sorted = [...items].sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  const latest = sorted[0];
  const summary: TaskReviewSummary | null = latest
    ? {
        summary: latest.title,
        verdict: (latest.reviewState as "APPROVE" | "REVISE" | "RETHINK" | "UNAVAILABLE" | null | undefined) ?? undefined,
      }
    : null;

  return {
    mode: "reviewer-agent",
    refreshable: true,
    fetchedAt: new Date().toISOString(),
    summary,
    items: sorted,
  };
}

async function maybeCreateTaskTrackingIssue(taskStore: TaskStore, task: Task, optionsToken?: string): Promise<void> {
  const projectSettings = await taskStore.getSettings();
  const globalSettings = (await taskStore.getGlobalSettingsStore?.()?.getSettings?.()) ?? {};
  const authMode = projectSettings.githubAuthMode;
  const token = authMode === "token"
    ? projectSettings.githubAuthToken ?? optionsToken
    : optionsToken;

  try {
    await maybeCreateTrackingIssue(task, {
      taskStore,
      githubClient: new GitHubClient(token),
      projectSettings,
      globalSettings,
      logger: console,
    });
  } catch {
    // best-effort only
  }
}

interface TaskWorkflowRouteDeps {
  runtimeLogger: { error: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void };
  upload: { single: (name: string) => unknown };
  taskDetailActivityLogLimit: number;
  validateOptionalModelField: (value: unknown, name: string) => string | undefined;
  normalizeModelSelectionPair: (provider: string | undefined, modelId: string | undefined) => { provider?: string | null; modelId?: string | null };
  runGitCommand: (args: string[], cwd: string, timeoutMs: number) => Promise<string>;
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
        priority,
        source,
        branch,
        baseBranch,
        branchSelection,
        nodeId,
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

      // Validate priority if provided.
      if (priority !== undefined && priority !== null && !isTaskPriority(priority)) {
        throw badRequest(`priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
      }

      if (nodeId !== undefined && nodeId !== null && typeof nodeId !== "string") {
        throw badRequest("nodeId must be a string");
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
              // 1. Project title summarizer lane
              // 2. Global title summarizer lane
              // 3. Project planning lane
              // 4. Project default override
              // 5. Global default
              const { provider: resolvedProvider, modelId: resolvedModelId } =
                resolveTitleSummarizerSettingsModel(settings);

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

      const normalizedSource =
        source && typeof source === "object" && "sourceType" in source && typeof (source as { sourceType?: unknown }).sourceType === "string"
          ? source
          : { sourceType: "api" as const };

      const { branch: normalizedBranch, baseBranch: normalizedBaseBranch } =
        resolveBranchSelection(branchSelection, branch, baseBranch);

      const createInput = {
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
        priority: priority ?? undefined,
        source: normalizedSource,
        branch: normalizedBranch,
        baseBranch: normalizedBaseBranch,
        ...(typeof nodeId === "string" && nodeId.trim().length > 0 ? { nodeId: nodeId.trim() } : {}),
      };

      if (typeof scopedStore.createTaskWithReservedId !== "function") {
        const task = await scopedStore.createTask(
          createInput,
          { onSummarize, settings: { autoSummarizeTitles: settings.autoSummarizeTitles } },
        );
        await maybeCreateTaskTrackingIssue(scopedStore, task, options?.githubToken);
        res.status(201).json(task);
        return;
      }

      const allocator = scopedStore.getDistributedTaskIdAllocator();
      const { CentralCore } = await import("@fusion/core");
      const central = new CentralCore();
      await central.init();
      const nodes = await central.listNodes();
      const localNode = nodes.find((node) => node.type === "local");
      const remoteNodes = nodes.filter((node) => node.type === "remote" && node.url && node.apiKey);
      await central.close();

      const nodeIdForReservation = localNode?.id ?? "local";
      const isOverlapClassFailure = (err: unknown): boolean => {
        const message = err instanceof Error ? err.message : String(err);
        return (
          message.includes("Task ID already exists:") ||
          message.includes("Replicated task payload collision for existing task")
        );
      };

      const maxCreateAttempts = 3;
      for (let attempt = 1; attempt <= maxCreateAttempts; attempt += 1) {
        const reservation = await allocator.reserveDistributedTaskId({
          prefix: "FN",
          nodeId: nodeIdForReservation,
        });

        let createdTask: Task | null = null;
        try {
          createdTask = await scopedStore.createTaskWithReservedId(createInput, {
            taskId: reservation.taskId,
          });
          await maybeCreateTaskTrackingIssue(scopedStore, createdTask, options?.githubToken);

          const replicatedPayload = buildMeshReplicatedTaskCreatePayload({
            taskId: createdTask.id,
            reservationId: reservation.reservationId,
            sourceNodeId: nodeIdForReservation,
            createdAt: createdTask.createdAt,
            updatedAt: createdTask.updatedAt,
            prompt: (await scopedStore.getTask(createdTask.id)).prompt,
            createInput: toReplicatedCreateInput(createdTask),
          });

          for (const peer of remoteNodes) {
            await fetchFromRemoteNode(peer, "/api/mesh/tasks/create", {
              method: "POST",
              body: replicatedPayload,
            });
          }

          await allocator.commitDistributedTaskIdReservation({
            reservationId: reservation.reservationId,
            nodeId: nodeIdForReservation,
          });

          res.status(201).json(createdTask);
          return;
        } catch (err: unknown) {
          await allocator.abortDistributedTaskIdReservation({
            reservationId: reservation.reservationId,
            nodeId: nodeIdForReservation,
            reason: "failed-create",
          }).catch(() => undefined);

          if (createdTask) {
            await scopedStore.deleteTask(createdTask.id).catch(() => undefined);
          }

          if (attempt < maxCreateAttempts && isOverlapClassFailure(err)) {
            continue;
          }

          const message = err instanceof Error ? err.message : String(err);
          throw new ApiError(503, `Cluster task create failed: ${message}`);
        }
      }
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
      const { column, preserveProgress } = req.body;
      if (!column || !COLUMNS.includes(column as Column)) {
        throw badRequest(`Invalid column. Must be one of: ${COLUMNS.join(", ")}`);
      }
      if (preserveProgress != null && typeof preserveProgress !== "boolean") {
        throw badRequest("preserveProgress must be a boolean");
      }

      // When manually promoting to in-progress, supply an allocator so
      // moveTask assigns a worktree path under its cross-task allocation
      // lock. This mirrors scheduler dispatch semantics — without it, a
      // user-initiated move would land the task in-progress with a stale
      // (or null) worktree and could collide with another active task.
      // The executor's createWorktree path will reuse `task.branch` if it
      // already exists, so any prior committed progress survives even
      // though the on-disk worktree directory is freshly allocated.
      let allocateWorktree: ((reservedNames: Set<string>) => string | null) | undefined;
      if ((column as Column) === "in-progress") {
        const existing = await scopedStore.getTask(req.params.id);
        if (existing) {
          const settings = await scopedStore.getSettings();
          const rootDir = scopedStore.getRootDir();
          allocateWorktree = (reservedNames) =>
            planTaskWorktreePath(existing, rootDir, settings.worktreeNaming, reservedNames);
        }
      }

      const task = await scopedStore.moveTask(req.params.id, column as Column, {
        preserveProgress,
        allocateWorktree,
      });
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

  // Retry failed, stuck-killed, or stranded triage/planning task
  router.post("/tasks/:id/retry", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      const retrySpecification =
        task.column === "triage" &&
        (task.status === "failed" ||
          task.status === "planning" ||
          task.status === "needs-replan" ||
          (task.stuckKillCount ?? 0) > 0);
      const isInReviewRetry =
        task.column === "in-review" &&
        (task.status === "failed" || task.status === "stuck-killed");
      if (task.status !== "failed" && task.status !== "stuck-killed" && !retrySpecification) {
        throw badRequest(`Task is not in a retryable state (current status: ${task.status || 'none'})`);
      }

      // In-review retry: keep the task in in-review, clear only error/retry state
      // so the auto-merge system re-attempts on its next sweep.
      if (isInReviewRetry) {
        await scopedStore.updateTask(req.params.id, {
          status: null,
          error: null,
          stuckKillCount: 0,
          mergeRetries: 0,
        });
        await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (in-review retry, mergeRetries reset)");
        const updated = await scopedStore.getTask(req.params.id);
        res.json(updated);
        return;
      }

      await scopedStore.updateTask(req.params.id, {
        status: retrySpecification ? "needs-replan" : null,
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
        await scopedStore.logEntry(req.params.id, "Retry requested from dashboard (planning retry budget reset)");
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

  // Nuclear reset — erase all progress and allocate a fresh worktree+branch on next run
  router.post("/tasks/:id/reset", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);

      const { confirm: confirmed } = (req.body ?? {}) as { confirm?: boolean };
      if (!confirmed) {
        throw badRequest(
          "This operation is destructive and will erase all task progress. Pass { \"confirm\": true } in the request body to proceed.",
        );
      }

      const task = await scopedStore.getTask(req.params.id);

      // Reset all steps to pending
      for (let i = 0; i < task.steps.length; i++) {
        if (task.steps[i].status !== "pending") {
          await scopedStore.updateStep(req.params.id, i, "pending");
        }
      }

      await scopedStore.updateTask(req.params.id, {
        worktree: null,
        branch: null,
        currentStep: 0,
        status: null,
        error: null,
        stuckKillCount: 0,
        taskDoneRetryCount: null,
        workflowStepRetries: undefined,
        recoveryRetryCount: null,
        nextRecoveryAt: null,
        postReviewFixCount: 0,
        verificationFailureCount: 0,
        mergeConflictBounceCount: 0,
      });

      await scopedStore.logEntry(
        req.params.id,
        "Task reset by user — all progress cleared, fresh worktree and branch will be allocated",
      );

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
      const {
        taskIds,
        modelProvider,
        modelId,
        validatorModelProvider,
        validatorModelId,
        planningModelProvider,
        planningModelId,
        nodeId,
      } = req.body;

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

      // Validate that at least one model field or node override is being updated
      const hasExecutorModel = modelProvider !== undefined || modelId !== undefined;
      const hasValidatorModel = validatorModelProvider !== undefined || validatorModelId !== undefined;
      const hasPlanningModel = planningModelProvider !== undefined || planningModelId !== undefined;
      const hasNodeId = nodeId !== undefined;
      if (!hasExecutorModel && !hasValidatorModel && !hasPlanningModel && !hasNodeId) {
        throw badRequest("At least one model field or nodeId must be provided");
      }

      if (nodeId !== undefined && nodeId !== null && typeof nodeId !== "string") {
        throw badRequest("nodeId must be a string, null, or undefined");
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
      const updates: {
        modelProvider?: string | null;
        modelId?: string | null;
        validatorModelProvider?: string | null;
        validatorModelId?: string | null;
        planningModelProvider?: string | null;
        planningModelId?: string | null;
        nodeId?: string | null;
      } = {};
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
      if (nodeId !== undefined) {
        updates.nodeId = nodeId;
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
  // Tool-oriented detail payloads may be clipped server-side to keep the
  // dashboard responsive when agents emit very large command results.
  // The 500-entry cap (MAX_LOG_ENTRIES) is still a client-side whole-list limit.
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
      const task = await scopedStore.getTask(req.params.id);
      if (task.assignedAgentId) {
        throw conflict(`Cannot manually pause/unpause task assigned to agent ${task.assignedAgentId}. Use agent pause controls instead.`);
      }
      const updated = await scopedStore.pauseTask(req.params.id, true);
      res.json(updated);
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
      const task = await scopedStore.getTask(req.params.id);
      if (task.assignedAgentId) {
        throw conflict(`Cannot manually pause/unpause task assigned to agent ${task.assignedAgentId}. Use agent pause controls instead.`);
      }
      const updated = await scopedStore.pauseTask(req.params.id, false);
      res.json(updated);
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
      // Just reset for replanning in place.
      if (task.column === "triage") {
        // Log the revision request
        await scopedStore.logEntry(task.id, "AI spec revision requested", feedback);

        // Remove the existing spec so replanning starts from the task
        // description and feedback rather than revising stale PROMPT.md content.
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        // Update status to indicate needs replanning
        await scopedStore.updateTask(task.id, { status: "needs-replan" });

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

      // Move to triage for replanning
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Remove the existing spec so replanning starts from the task
      // description and feedback rather than revising stale PROMPT.md content.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs replanning
      await scopedStore.updateTask(task.id, { status: "needs-replan" });

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
      // Just reset for replanning in place.
      if (task.column === "triage") {
        // Log the rebuild request
        await scopedStore.logEntry(task.id, "Specification rebuild requested by user");

        // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
        // of asking triage to revise whatever was already on disk.
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
        await rm(promptPath, { force: true });

        // Update status to indicate needs replanning
        await scopedStore.updateTask(task.id, { status: "needs-replan" });

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

      // Move to triage for replanning
      const updated = await scopedStore.moveTask(task.id, "triage");

      // Remove the existing spec so rebuilds produce a fresh PROMPT.md instead
      // of asking triage to revise whatever was already on disk.
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const promptPath = join(scopedStore.getRootDir(), ".fusion", "tasks", task.id, "PROMPT.md");
      await rm(promptPath, { force: true });

      // Update status to indicate needs replanning
      await scopedStore.updateTask(task.id, { status: "needs-replan" });

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
      const { title, description, prompt, priority, dependencies, enabledWorkflowSteps, modelProvider, modelId, validatorModelProvider, validatorModelId, planningModelProvider, planningModelId, thinkingLevel, assigneeUserId, reviewLevel, executionMode, sourceIssue, nodeId, branch, baseBranch } = req.body;
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

      // Validate priority if provided. `null` resets to the default (`normal`)
      // via store.updateTask's null-handling.
      if (priority !== undefined && priority !== null && !isTaskPriority(priority)) {
        throw new Error(`priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
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

      let validatedNodeId: string | null | undefined;
      if (hasBodyField("nodeId")) {
        if (nodeId === undefined) {
          validatedNodeId = undefined;
        } else if (nodeId === null) {
          validatedNodeId = null;
        } else if (typeof nodeId === "string") {
          const trimmed = nodeId.trim();
          if (trimmed.length === 0) {
            throw new Error("nodeId must be a non-empty string");
          }
          validatedNodeId = trimmed;
        } else {
          throw new Error("nodeId must be a string or null");
        }
      }

      const validatePatchBranchField = (value: unknown, fieldName: string): string | null | undefined => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== "string") {
          throw new Error(`${fieldName} must be a string or null`);
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      };

      const normalizedBranch = hasBodyField("branch") ? validatePatchBranchField(branch, "branch") : undefined;
      const normalizedBaseBranch = hasBodyField("baseBranch") ? validatePatchBranchField(baseBranch, "baseBranch") : undefined;

      const updates: Parameters<typeof scopedStore.updateTask>[1] = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (prompt !== undefined) updates.prompt = prompt;
      if (hasBodyField("priority")) updates.priority = priority;
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
      if (hasBodyField("nodeId")) updates.nodeId = validatedNodeId;
      if (hasBodyField("branch")) updates.branch = normalizedBranch;
      if (hasBodyField("baseBranch")) updates.baseBranch = normalizedBaseBranch;

      if (hasBodyField("nodeId") && validatedNodeId !== undefined) {
        const currentTask = await scopedStore.getTask(req.params.id);
        if (!currentTask) {
          throw notFound("Task not found");
        }
        const validation = validateNodeOverrideChange(currentTask, validatedNodeId ?? null);
        if (!validation.allowed) {
          throw new ApiError(409, validation.message ?? "Node override change blocked");
        }
      }

      const task = await scopedStore.updateTask(req.params.id, updates);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const status = (err instanceof Error ? err.message : String(err)).includes("must be a string") || (err instanceof Error ? err.message : String(err)).includes("must be a non-empty string") || (err instanceof Error ? err.message : String(err)).includes("must be a string or null") || (err instanceof Error ? err.message : String(err)).includes("must be an array of strings") || (err instanceof Error ? err.message : String(err)).includes("thinkingLevel must be one of") || (err instanceof Error ? err.message : String(err)).includes("reviewLevel must be an integer") || (err instanceof Error ? err.message : String(err)).includes("executionMode must be one of") || (err instanceof Error ? err.message : String(err)).includes("priority must be one of") || (err instanceof Error ? err.message : String(err)).includes("sourceIssue") ? 400 : 500;
      throw new ApiError(status, err instanceof Error ? err.message : String(err));
    }
  });

  // Assign or unassign a task to an explicit agent
  router.patch("/tasks/:id/assign", async (req, res) => {
    try {
      const { agentId, override } = req.body as { agentId?: string | null; override?: boolean };
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

        const targetTask = await scopedStore.getTask(req.params.id);
        if (!targetTask) {
          throw notFound("Task not found");
        }

        if (override !== true && !canAgentTakeImplementationTask(agent, targetTask)) {
          throw new ApiError(409, formatRoleMismatchReason(agent, targetTask));
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

  router.get("/tasks/:id/review", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      let reviewData: TaskReviewData;

      if (task.prInfo) {
        const badgeParsed = parseGitHubBadgeUrl(task.prInfo.url);
        const repoInfo = getCurrentRepo(scopedStore.getRootDir());
        const owner = badgeParsed?.owner ?? repoInfo?.owner;
        const repo = badgeParsed?.repo ?? repoInfo?.repo;
        if (!owner || !repo) {
          throw badRequest("Could not determine GitHub repository for PR review fetch");
        }
        reviewData = await new GitHubClient(options?.githubToken ?? process.env.GITHUB_TOKEN).getPrReviewDetails(owner, repo, task.prInfo.number);
      } else {
        reviewData = await buildDirectTaskReviewData(task, scopedStore);
      }

      res.json(reviewData);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err);
    }
  });

  router.post("/tasks/:id/review/refresh", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);
      let reviewData: TaskReviewData;
      if (task.prInfo) {
        const badgeParsed = parseGitHubBadgeUrl(task.prInfo.url);
        const repoInfo = getCurrentRepo(scopedStore.getRootDir());
        const owner = badgeParsed?.owner ?? repoInfo?.owner;
        const repo = badgeParsed?.repo ?? repoInfo?.repo;
        if (!owner || !repo) {
          throw badRequest("Could not determine GitHub repository for PR review refresh");
        }
        reviewData = await new GitHubClient(options?.githubToken ?? process.env.GITHUB_TOKEN).getPrReviewDetails(owner, repo, task.prInfo.number);
      } else {
        reviewData = await buildDirectTaskReviewData(task, scopedStore);
      }
      res.json(reviewData);
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(`Task ${req.params.id} not found`);
      }
      rethrowAsApiError(err);
    }
  });

  // Queue same-task revision pass for selected review items
  router.post("/tasks/:id/review/address", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const task = await scopedStore.getTask(req.params.id);

      type SelectedReviewItem = {
        id: string;
        source: "pr-review" | "reviewer-agent";
        threadId?: string;
        filePath?: string;
        lineNumber?: number;
        author?: string;
        summary: string;
        body: string;
        url?: string;
      };

      const selectedItems: SelectedReviewItem[] = Array.isArray(req.body?.selectedItems)
        ? req.body.selectedItems.filter((value: unknown): value is SelectedReviewItem => {
            if (!value || typeof value !== "object") return false;
            const item = value as Record<string, unknown>;
            return typeof item.id === "string" && item.id.trim().length > 0 && typeof item.summary === "string" && typeof item.body === "string";
          })
        : [];

      if (selectedItems.length === 0) {
        throw badRequest("selectedItems must be a non-empty array of review items");
      }
      const unsupportedSource = selectedItems.find((item) => item.source !== "pr-review" && item.source !== "reviewer-agent");
      if (unsupportedSource) {
        throw badRequest(`Unsupported review source: ${String(unsupportedSource.source)}`);
      }
      if (!task.reviewState) {
        throw badRequest("Task has no reviewState payload");
      }

      const now = new Date().toISOString();
      const selectedSet = new Set(selectedItems.map((item: SelectedReviewItem) => item.id));
      const sourceById = new Map(selectedItems.map((item: SelectedReviewItem) => [item.id, item.source] as const));
      const reviewSourceMismatch = task.reviewState.items.find((item: NonNullable<typeof task.reviewState>["items"][number]) => {
        const selectedSource = sourceById.get(item.id);
        if (!selectedSource || !task.reviewState) return false;
        const expectedSource = task.reviewState.source === "pull-request" ? "pr-review" : "reviewer-agent";
        return selectedSource !== expectedSource;
      });
      if (reviewSourceMismatch) {
        throw badRequest("Selected review source does not match task review mode");
      }
      const matchedItems = task.reviewState.items.filter((item: NonNullable<typeof task.reviewState>["items"][number]) => selectedSet.has(item.id));
      if (matchedItems.length !== selectedSet.size) {
        throw badRequest("selectedItems must reference existing review items");
      }

      const modeSummary = `${task.reviewState.source === "pull-request" ? "pull-request" : "reviewer-agent"} · ${selectedItems.length} selected item(s)`;
      const steeringItems = selectedItems.map((item: SelectedReviewItem, index: number) => {
        const location = item.filePath ? `${item.filePath}${typeof item.lineNumber === "number" ? `:${item.lineNumber}` : ""}` : undefined;
        const snippetSource = item.body.trim() || item.summary.trim();
        const snippet = snippetSource.length > 220 ? `${snippetSource.slice(0, 220)}…` : snippetSource;
        const urlSuffix = item.url ? ` | url: ${item.url}` : "";
        return `${index + 1}. source: ${item.source}${location ? ` | location: ${location}` : ""} | "${snippet}"${urlSuffix}`;
      });
      const steeringText = ["Selected review feedback to address", modeSummary, ...steeringItems].join("\n");

      const priorAddressingById = new Map(task.reviewState.addressing.map((record) => [record.itemId, record] as const));
      const nextAddressing = [
        ...task.reviewState.addressing.filter((record) => !selectedSet.has(record.itemId)),
        ...selectedItems.map((item: SelectedReviewItem) => {
          const existing = priorAddressingById.get(item.id);
          return {
            itemId: item.id,
            status: "queued" as const,
            selectedAt: now,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
            stale: false,
            snapshot: {
              itemId: item.id,
              sourceMode: task.reviewState?.source ?? "pull-request",
              source: item.source,
              summary: item.summary,
              body: item.body,
              authorLogin: item.author,
              filePath: item.filePath,
              lineNumber: item.lineNumber,
              threadId: item.threadId,
              url: item.url,
            },
            ...(existing ? { startedAt: existing.startedAt, completedAt: existing.completedAt } : {}),
          };
        }),
      ];

      const reviewState = {
        ...task.reviewState,
        addressing: nextAddressing,
      };

      await scopedStore.updateTask(task.id, { reviewState });

      let steeringCommentId: string | null = null;
      const steeringComment = await scopedStore.addSteeringComment(task.id, steeringText, "user");
      steeringCommentId = steeringComment.id;

      let updatedTask: Task = await scopedStore.getTask(task.id);

      if (task.column === "in-review") {
        await scopedStore.updateTask(task.id, {
          status: null,
          error: null,
          sessionFile: null,
        });
        const lastDoneStep = [...task.steps]
          .map((step, index) => ({ step, index }))
          .reverse()
          .find(({ step }) => step.status === "done" || step.status === "in-progress");
        if (lastDoneStep) {
          await scopedStore.updateStep(task.id, lastDoneStep.index, "pending");
        }
        updatedTask = await scopedStore.moveTask(task.id, "in-progress", { preserveProgress: true });
      }

      const hasActiveSession = Boolean(updatedTask.sessionFile);
      if (steeringCommentId && updatedTask.column === "in-progress" && updatedTask.assignedAgentId && !hasActiveSession) {
        await triggerCommentWakeForAssignedAgent(scopedStore, updatedTask, {
          triggeringCommentType: "steering",
          triggeringCommentIds: [steeringCommentId],
          triggerDetail: "review-address",
        });
      }

      await scopedStore.logEntry(task.id, "Same-task review revision requested", `${selectedItems.length} item(s) submitted from review tab`);
      res.json({ task: updatedTask, reviewState });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
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


}
