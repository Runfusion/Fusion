import { ApiError, badRequest, notFound } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

type NormalizedAuditEvent = import("../routes.js").NormalizedRunAuditEvent;
type TimelineEntry = import("../routes.js").TimelineEntry;
type RunAuditResponse = import("../routes.js").RunAuditResponse;
type RunTimelineResponse = import("../routes.js").RunTimelineResponse;

interface AgentRuntimeRouteDeps {
  validateAgentInstructionsPayload: (instructionsPath: unknown, instructionsText: unknown) => boolean;
  serializeAccessState: (state: import("@fusion/core").AgentAccessState) => {
    resolvedPermissions: string[];
    explicitPermissions: string[];
    roleDefaultPermissions: string[];
  } & Omit<import("@fusion/core").AgentAccessState, "resolvedPermissions" | "explicitPermissions" | "roleDefaultPermissions">;
  hasHeartbeatExecutor: boolean;
  heartbeatMonitor: import("../server.js").ServerOptions["heartbeatMonitor"];
  isHeartbeatMonitorForProject: (scopedStore: import("@fusion/core").TaskStore) => boolean;
  runExcerptToAgentLogs: (run: import("@fusion/core").AgentHeartbeatRun) => import("@fusion/core").AgentLogEntry[];
  parseRunAuditFilters: (query: Record<string, unknown>) => {
    taskId?: string;
    domain?: "database" | "git" | "filesystem";
    startTime?: string;
    endTime?: string;
    limit?: number;
  };
  normalizeRunAuditEvent: (event: import("@fusion/core").RunAuditEvent) => NormalizedAuditEvent;
  auditEventToTimelineEntry: (event: import("@fusion/core").RunAuditEvent) => TimelineEntry;
  logEntryToTimelineEntry: (entry: import("@fusion/core").AgentLogEntry) => TimelineEntry;
  compareTimelineEntries: (a: TimelineEntry, b: TimelineEntry) => number;
  listAgentMemoryFiles: typeof import("@fusion/core").listAgentMemoryFiles;
  readAgentMemoryFile: typeof import("@fusion/core").readAgentMemoryFile;
  writeAgentMemoryFile: typeof import("@fusion/core").writeAgentMemoryFile;
  isMemoryBackendError: (error: unknown) => error is { code: string; backend?: string; message: string };
}

export function registerAgentRuntimeRoutes(ctx: ApiRoutesContext, deps: AgentRuntimeRouteDeps): void {
  const { router, getProjectContext, rethrowAsApiError } = ctx;
  const {
    validateAgentInstructionsPayload,
    serializeAccessState,
    hasHeartbeatExecutor,
    heartbeatMonitor,
    isHeartbeatMonitorForProject,
    runExcerptToAgentLogs,
    parseRunAuditFilters,
    normalizeRunAuditEvent,
    auditEventToTimelineEntry,
    logEntryToTimelineEntry,
    compareTimelineEntries,
    listAgentMemoryFiles,
    readAgentMemoryFile,
    writeAgentMemoryFile,
    isMemoryBackendError,
  } = deps;

  /**
   * GET /api/agents/:id/access
   * Get computed access state for an agent.
   */
  router.get("/agents/:id/access", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore, computeAccessState } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const state = computeAccessState(agent);
      res.json(serializeAccessState(state));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/permissions
   * Update agent permission grants.
   */
  router.patch("/agents/:id/permissions", async (req, res) => {
    try {
      const { permissions } = req.body ?? {};

      if (permissions === undefined || permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) {
        throw badRequest("permissions must be an object");
      }

      const { AgentStore, isValidPermission } = await import("@fusion/core");

      for (const [key, value] of Object.entries(permissions as Record<string, unknown>)) {
        if (key.startsWith("budget:")) {
          throw badRequest("Budget permissions are not supported");
        }
        if (!isValidPermission(key)) {
          throw badRequest(`Invalid permission: ${key}`);
        }
        if (typeof value !== "boolean") {
          throw badRequest(`Permission value for ${key} must be boolean`);
        }
      }

      const { store: scopedStore } = await getProjectContext(req);
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, {
        permissions: permissions as Record<string, boolean>,
      });
      res.json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * PATCH /api/agents/:id/instructions
   * Update agent custom instructions.
   * Body: { instructionsPath?: string, instructionsText?: string }
   */
  router.patch("/agents/:id/instructions", async (req, res) => {
    try {
      const { instructionsPath, instructionsText } = req.body ?? {};
      if (!validateAgentInstructionsPayload(instructionsPath, instructionsText)) {
        return;
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, {
        instructionsPath: instructionsPath ?? undefined,
        instructionsText: instructionsText ?? undefined,
      });
      res.json(agent);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/soul
   * Fetch agent soul/personality text.
   */
  router.get("/agents/:id/soul", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ soul: agent.soul ?? null });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/soul
   * Update agent soul/personality text.
   * Body: { soul: string }
   */
  router.patch("/agents/:id/soul", async (req, res) => {
    try {
      const { soul } = req.body ?? {};
      if (typeof soul !== "string") {
        throw badRequest("soul must be a string");
      }
      if (soul.length > 10000) {
        throw badRequest("soul must be at most 10,000 characters");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, { soul });
      res.json(agent);
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

  /**
   * GET /api/agents/:id/memory
   * Fetch per-agent memory text.
   */
  router.get("/agents/:id/memory", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      res.json({ memory: agent.memory ?? null });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * PATCH /api/agents/:id/memory
   * Update per-agent memory text.
   * Body: { memory: string }
   */
  router.patch("/agents/:id/memory", async (req, res) => {
    try {
      const { memory } = req.body ?? {};
      if (typeof memory !== "string") {
        throw badRequest("memory must be a string");
      }
      if (memory.length > 50000) {
        throw badRequest("memory must be at most 50,000 characters");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.updateAgent(req.params.id, { memory });
      res.json(agent);
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

  /**
   * GET /api/agents/:id/memory/files
   * Lists OpenClaw memory files for one agent.
   */
  router.get("/agents/:id/memory/files", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = req.params.id;
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rootDir = scopedStore.getRootDir();
      const files = await listAgentMemoryFiles(rootDir, agentId);
      res.json({ files });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (isMemoryBackendError(err)) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "UNSUPPORTED" ? 400 : 500;
        throw new ApiError(status, `Memory operation failed: ${err.message}`, { code: err.code, backend: err.backend });
      }
      rethrowAsApiError(err, "Failed to list agent memory files");
    }
  });

  /**
   * GET /api/agents/:id/memory/file?path=.fusion/agent-memory/:id/MEMORY.md
   * Reads a validated agent memory file.
   */
  router.get("/agents/:id/memory/file", async (req, res) => {
    try {
      const path = typeof req.query.path === "string" ? req.query.path : "";
      if (!path) {
        throw badRequest("path is required");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = req.params.id;
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rootDir = scopedStore.getRootDir();
      const result = await readAgentMemoryFile(rootDir, agentId, path);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (isMemoryBackendError(err)) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "UNSUPPORTED" ? 400 : 500;
        throw new ApiError(status, `Memory operation failed: ${err.message}`, { code: err.code, backend: err.backend });
      }
      rethrowAsApiError(err, "Failed to read agent memory file");
    }
  });

  /**
   * PUT /api/agents/:id/memory/file
   * Writes one validated agent memory file.
   */
  router.put("/agents/:id/memory/file", async (req, res) => {
    try {
      const { path, content } = req.body ?? {};
      if (typeof path !== "string" || !path.trim()) {
        throw badRequest("path must be a string");
      }
      if (typeof content !== "string") {
        throw badRequest("content must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = req.params.id;
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rootDir = scopedStore.getRootDir();
      const result = await writeAgentMemoryFile(rootDir, agentId, path, content);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (isMemoryBackendError(err)) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "UNSUPPORTED" ? 400 : 500;
        throw new ApiError(status, `Memory operation failed: ${err.message}`, { code: err.code, backend: err.backend });
      }
      rethrowAsApiError(err, "Failed to save agent memory file");
    }
  });

  /**
   * POST /api/agents/:id/state
   * Update agent state.
   * Body: { state: AgentState }
   */
  router.post("/agents/:id/state", async (req, res) => {
    try {
      const { state } = req.body;
      if (!state || typeof state !== "string") {
        throw badRequest("state is required");
      }

      const nextState = state as import("@fusion/core").AgentState;
      const agentId = req.params.id;

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const currentAgent = await agentStore.getAgent(agentId);
      if (!currentAgent) {
        throw notFound("Agent not found");
      }

      const projectHeartbeatMonitor = hasHeartbeatExecutor
        && heartbeatMonitor
        && isHeartbeatMonitorForProject(scopedStore)
        ? heartbeatMonitor
        : null;

      const updatedAgent = await agentStore.updateAgentState(agentId, nextState);
      res.json(updatedAgent);

      void (async () => {
        try {
          if (nextState === "paused" && projectHeartbeatMonitor) {
            const activeRun = await agentStore.getActiveHeartbeatRun(agentId);
            if (activeRun) {
              await projectHeartbeatMonitor.stopRun(agentId);
              const agentAfterStop = await agentStore.getAgent(agentId);
              if (agentAfterStop && agentAfterStop.state !== "paused") {
                await agentStore.updateAgentState(agentId, "paused");
              }
            }
          }

          const isHeartbeatEnabled = currentAgent.runtimeConfig?.enabled !== false;
          if (nextState === "active" && isHeartbeatEnabled && projectHeartbeatMonitor) {
            await projectHeartbeatMonitor.executeHeartbeat({
              agentId,
              source: "on_demand",
              triggerDetail: "Triggered from state resume",
              contextSnapshot: {
                wakeReason: "on_demand",
                triggerDetail: "Triggered from state resume",
                triggerSource: "state-resume",
              },
            });
          }
        } catch (err) {
          console.error(`[agent-state] async heartbeat work failed for ${agentId}:`, err);
        }
      })();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else if (/invalid state transition/i.test(err instanceof Error ? err.message : String(err))) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/config-revisions
   * List config revisions for an agent.
   * Query: limit (default: 50)
   */
  router.get("/agents/:id/config-revisions", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const rawLimit = req.query.limit;
      const limit = rawLimit === undefined ? 50 : Number.parseInt(String(rawLimit), 10);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw badRequest("limit must be a positive integer");
      }

      const revisions = await agentStore.getConfigRevisions(req.params.id, limit);
      res.json(revisions);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/config-revisions/:revisionId
   * Get a specific config revision for an agent.
   */
  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const revision = await agentStore.getConfigRevision(req.params.id, req.params.revisionId);
      if (!revision) {
        throw notFound("Config revision not found");
      }

      res.json(revision);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/config-revisions/:revisionId/rollback
   * Roll back an agent to a previous config revision.
   */
  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const result = await agentStore.rollbackConfig(req.params.id, req.params.revisionId);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("belongs to agent")) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      } else if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/budget
   * Get budget status for an agent.
   */
  router.get("/agents/:id/budget", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const budgetStatus = await agentStore.getBudgetStatus(req.params.id);
      res.json(budgetStatus);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/:id/budget/reset
   * Reset budget usage for an agent.
   */
  router.post("/agents/:id/budget/reset", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      await agentStore.resetBudgetUsage(req.params.id);
      res.json({ success: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/:id/keys
   * Create a new API key for an agent.
   * Body: { label?: string }
   */
  router.post("/agents/:id/keys", async (req, res) => {
    try {
      const { label } = req.body ?? {};
      if (label !== undefined && typeof label !== "string") {
        throw badRequest("label must be a string");
      }

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const result = await agentStore.createApiKey(req.params.id, { label });
      res.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/keys
   * List all API keys for an agent.
   */
  router.get("/agents/:id/keys", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const keys = await agentStore.listApiKeys(req.params.id);
      res.json(keys);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * DELETE /api/agents/:id/keys/:keyId
   * Revoke an API key for an agent.
   */
  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const revoked = await agentStore.revokeApiKey(req.params.id, req.params.keyId);
      res.json(revoked);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/tasks
   * List tasks explicitly assigned to the given agent.
   */
  router.get("/agents/:id/tasks", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const tasks = await scopedStore.listTasks({ slim: true, includeArchived: false });
      res.json(tasks.filter((task) => task.assignedAgentId === req.params.id));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/inbox
   * Select the next inbox-lite task candidate for an agent.
   *
   * Returns `{ task, priority, reason }` when work is available,
   * or `{ task: null }` when no matching work is found.
   */
  router.post("/agents/:id/inbox", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agentId = req.params.id;
      const agent = await agentStore.getAgent(agentId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const selection = await scopedStore.selectNextTaskForAgent(agentId);
      if (!selection) {
        res.json({ task: null });
        return;
      }

      res.json({
        task: selection.task,
        priority: selection.priority,
        reason: selection.reason,
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * POST /api/agents/:id/heartbeat
   * Record a heartbeat for an agent.
   * Body: { status?: "ok"|"missed"|"recovered", triggerExecution?: boolean }
   *
   * When triggerExecution is true AND HeartbeatMonitor is available,
   * also executes a heartbeat run after recording the heartbeat event.
   *
   * UTILITY PATH: Heartbeat routes are on a separate control-plane lane and are
   * independent of task-lane saturation. They must NOT be gated on maxConcurrent,
   * semaphore state, or queue depth.
   */
  router.post("/agents/:id/heartbeat", async (req, res) => {
    try {
      const { status = "ok", triggerExecution } = req.body;

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const event = await agentStore.recordHeartbeat(req.params.id, status as "ok" | "missed" | "recovered");

      // Optionally trigger execution
      let run: import("@fusion/core").AgentHeartbeatRun | undefined;
      if (triggerExecution && hasHeartbeatExecutor && heartbeatMonitor && isHeartbeatMonitorForProject(scopedStore)) {
        run = await heartbeatMonitor.executeHeartbeat({
          agentId: req.params.id,
          source: "on_demand",
          triggerDetail: "Triggered from heartbeat",
          contextSnapshot: {
            wakeReason: "on_demand",
            triggerDetail: "Triggered from heartbeat",
          },
        });
      }

      res.json(run ? { event, run } : event);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/heartbeats
   * Get heartbeat history for an agent.
   * Query: limit (default: 50)
   */
  router.get("/agents/:id/heartbeats", async (req, res) => {
    try {
      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;

      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const history = await agentStore.getHeartbeatHistory(req.params.id, limit);
      res.json(history);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      rethrowAsApiError(err);
    }
  });

  /**
   * GET /api/agents/:id/runs
   * List recent runs for an agent.
   * Query: limit (default: 20)
   */
  router.get("/agents/:id/runs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 20;
      const runs = await agentStore.getRecentRuns(req.params.id, limit);
      res.json(runs);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/:id/runs
   * Manually start a heartbeat run for an agent.
   * Body: {
   *   source?: HeartbeatInvocationSource,
   *   triggerDetail?: string,
   *   taskId?: string,
   *   triggeringCommentIds?: string[],
   *   triggeringCommentType?: "steering" | "task" | "pr",
   * }
   *
   * When HeartbeatMonitor is available, delegates to executeHeartbeat() with
   * a structured wake context snapshot. This ensures a single authoritative run
   * record is created and fully completed without duplicate startRun calls.
   *
   * Returns 409 Conflict if the agent already has an active run.
   *
   * UTILITY PATH: Agent run routes are on a separate control-plane lane and are
   * independent of task-lane saturation. They must NOT be gated on maxConcurrent,
   * semaphore state, or queue depth. The active-run 409 contract is preserved:
   * { error: "Agent already has an active run", details: { runId } }.
   */
  router.post("/agents/:id/runs", async (req, res) => {
    try {
      const { source, triggerDetail, taskId, triggeringCommentIds, triggeringCommentType } = req.body || {};
      const invocationSource = source ?? "on_demand";
      const trigger = triggerDetail ?? "Triggered from dashboard";

      if (triggeringCommentIds !== undefined) {
        if (!Array.isArray(triggeringCommentIds) || triggeringCommentIds.some((id) => typeof id !== "string")) {
          throw badRequest("triggeringCommentIds must be an array of strings");
        }
      }
      if (
        triggeringCommentType !== undefined
        && triggeringCommentType !== "steering"
        && triggeringCommentType !== "task"
        && triggeringCommentType !== "pr"
      ) {
        throw badRequest("triggeringCommentType must be one of: steering, task, pr");
      }

      const normalizedTriggeringCommentIds = Array.isArray(triggeringCommentIds)
        ? triggeringCommentIds.map((id) => id.trim()).filter((id) => id.length > 0)
        : undefined;
      const normalizedTriggeringCommentType =
        triggeringCommentType === "steering" || triggeringCommentType === "task" || triggeringCommentType === "pr"
          ? triggeringCommentType
          : undefined;

      // Build structured wake context
      const contextSnapshot: Record<string, unknown> = {
        wakeReason: invocationSource,
        triggerDetail: trigger,
      };
      if (taskId) {
        contextSnapshot.taskId = taskId;
      }
      if (normalizedTriggeringCommentIds?.length) {
        contextSnapshot.triggeringCommentIds = normalizedTriggeringCommentIds;
      }
      if (normalizedTriggeringCommentType) {
        contextSnapshot.triggeringCommentType = normalizedTriggeringCommentType;
      }

      if (hasHeartbeatExecutor && heartbeatMonitor) {
        // Check for existing active run
        const { store: scopedStore } = await getProjectContext(req);

        // Guard: heartbeatMonitor is bound to a specific project root directory.
        // Reject when the scoped store belongs to a different project.
        if (!isHeartbeatMonitorForProject(scopedStore)) {
          throw new ApiError(400, "Agent execution is only available for the server's primary project. The heartbeat monitor is not bound to this project.");
        }

        const { AgentStore: AgentStoreClass } = await import("@fusion/core");
        const agentStore = new AgentStoreClass({ rootDir: scopedStore.getFusionDir() });
        await agentStore.init();

        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) {
          throw notFound(`Agent ${req.params.id} not found`);
        }

        const activeRun = await agentStore.getActiveHeartbeatRun(req.params.id);
        if (activeRun) {
          throw new ApiError(409, "Agent already has an active run", { runId: activeRun.id });
        }

        // Execute heartbeat end-to-end (single run record, no duplicate startRun call)
        const run = await heartbeatMonitor.executeHeartbeat({
          agentId: req.params.id,
          source: invocationSource,
          triggerDetail: trigger,
          taskId,
          triggeringCommentIds: normalizedTriggeringCommentIds,
          triggeringCommentType: normalizedTriggeringCommentType,
          contextSnapshot,
        });

        res.status(201).json(run);
      } else {
        // Fallback: record-only behavior without HeartbeatMonitor
        const { store: scopedStore } = await getProjectContext(req);
        const { AgentStore } = await import("@fusion/core");
        const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
        await agentStore.init();

        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) {
          throw notFound(`Agent ${req.params.id} not found`);
        }

        // Check for existing active run
        const activeRun = await agentStore.getActiveHeartbeatRun(req.params.id);
        if (activeRun) {
          throw new ApiError(409, "Agent already has an active run", { runId: activeRun.id });
        }

        const run = await agentStore.startHeartbeatRun(req.params.id);

        // Enrich with invocation source, trigger detail, and context snapshot
        run.invocationSource = invocationSource;
        run.triggerDetail = trigger;
        run.contextSnapshot = contextSnapshot;

        await agentStore.saveRun(run);
        res.status(201).json(run);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * POST /api/agents/:id/runs/stop
   * Stop the currently active heartbeat run for an agent.
   */
  router.post("/agents/:id/runs/stop", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const agent = await agentStore.getAgent(req.params.id);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const activeRun = await agentStore.getActiveHeartbeatRun(req.params.id);
      if (!activeRun) {
        res.status(200).json({ ok: true, message: "No active run" });
        return;
      }

      if (hasHeartbeatExecutor && heartbeatMonitor && isHeartbeatMonitorForProject(scopedStore)) {
        await heartbeatMonitor.stopRun(req.params.id);
      } else {
        const existingRun = await agentStore.getRunDetail(req.params.id, activeRun.id);
        if (existingRun) {
          await agentStore.saveRun({
            ...existingRun,
            endedAt: new Date().toISOString(),
            status: "terminated",
            stderrExcerpt: existingRun.stderrExcerpt ?? "Run stopped by user",
          });
        }

        await agentStore.endHeartbeatRun(activeRun.id, "terminated");

        try {
          await agentStore.updateAgentState(req.params.id, "active");
        } catch {
          // Best effort to restore an idle/active state for follow-up runs.
        }
      }

      res.status(200).json({ ok: true, runId: activeRun.id });
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

  /**
   * GET /api/agents/:id/runs/:runId
   * Get detail for a specific agent run.
   */
  router.get("/agents/:id/runs/:runId", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }
      res.json(run);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/runs/:runId/logs
   * Get agent log entries for a specific run's time window.
   * Uses the run's contextSnapshot.taskId to locate the task's agent log,
   * then filters entries by the run's startedAt/endedAt timestamps.
   * Returns an empty array if the run has no associated task.
   */
  router.get("/agents/:id/runs/:runId/logs", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Only use the run's context snapshot for task ID — do not fall back
      // to agent.taskId since that represents the agent's *current* task,
      // not the task active during a historical run.
      const taskId = run.contextSnapshot?.taskId as string | undefined;
      if (!taskId) {
        res.json(runExcerptToAgentLogs(run));
        return;
      }

      const logs = await scopedStore.getAgentLogsByTimeRange(
        taskId,
        run.startedAt,
        run.endedAt,
      );
      res.json(logs.length > 0 ? logs : runExcerptToAgentLogs(run));
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/runs/:runId/mutations
   * Get the mutation trail for a specific agent run.
   * Returns all TaskLogEntry objects correlated with the given runId via runContext.
   */
  router.get("/agents/:id/runs/:runId/mutations", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      // Verify the run exists
      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Query mutation trail
      const mutations = await scopedStore.getMutationsForRun(req.params.runId);
      res.json({ runId: req.params.runId, mutations });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/runs/:runId/audit
   * Get normalized run-audit events for a specific agent run.
   *
   * Query params:
   *   - taskId: Filter by task ID
   *   - domain: Filter by domain (database, git, filesystem)
   *   - startTime: Start of time range (ISO-8601)
   *   - endTime: End of time range (ISO-8601)
   *   - limit: Maximum events to return (default 100, max 1000)
   *
   * Response: RunAuditResponse with normalized events and filter metadata
   */
  router.get("/agents/:id/runs/:runId/audit", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      // Validate runId is not blank/whitespace
      const runId = req.params.runId;
      if (!runId || runId.trim().length === 0) {
        throw badRequest("runId is required");
      }

      // Verify the run exists
      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Parse and validate query filters
      const filters = parseRunAuditFilters(req.query as Record<string, unknown>);

      // Query run-audit events with runId as the primary filter
      const auditEvents = scopedStore.getRunAuditEvents({
        runId: req.params.runId,
        taskId: filters.taskId,
        domain: filters.domain,
        startTime: filters.startTime,
        endTime: filters.endTime,
        limit: filters.limit,
      });

      // Normalize events for UI consumption
      const normalizedEvents = auditEvents.map(normalizeRunAuditEvent);

      // Get total count (without limit) for pagination metadata
      const totalEvents = scopedStore.getRunAuditEvents({
        runId: req.params.runId,
        taskId: filters.taskId,
        domain: filters.domain,
        startTime: filters.startTime,
        endTime: filters.endTime,
      });

      const response: RunAuditResponse = {
        runId: req.params.runId,
        events: normalizedEvents,
        filters: {
          taskId: filters.taskId,
          domain: filters.domain,
          startTime: filters.startTime,
          endTime: filters.endTime,
        },
        totalCount: totalEvents.length,
        hasMore: filters.limit !== undefined && totalEvents.length > filters.limit,
      };

      res.json(response);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

  /**
   * GET /api/agents/:id/runs/:runId/timeline
   * Get a correlated timeline combining run-audit events and agent logs for a specific run.
   *
   * Query params:
   *   - taskId: Override task ID for audit filtering (defaults to run's contextSnapshot.taskId)
   *   - domain: Filter audit events by domain (database, git, filesystem)
   *   - startTime: Start of time range (ISO-8601)
   *   - endTime: End of time range (ISO-8601)
   *   - includeLogs: Whether to include agent logs (default true)
   *   - limit: Maximum audit events to return (default 100, max 1000)
   *
   * Response: RunTimelineResponse with run metadata, grouped audit events, and merged timeline
   */
  router.get("/agents/:id/runs/:runId/timeline", async (req, res) => {
    try {
      const { store: scopedStore } = await getProjectContext(req);
      const { AgentStore } = await import("@fusion/core");
      const agentStore = new AgentStore({ rootDir: scopedStore.getFusionDir() });
      await agentStore.init();

      // Validate runId is not blank/whitespace
      const runId = req.params.runId;
      if (!runId || runId.trim().length === 0) {
        throw badRequest("runId is required");
      }

      // Verify the run exists
      const run = await agentStore.getRunDetail(req.params.id, req.params.runId);
      if (!run) {
        throw notFound("Run not found");
      }

      // Parse and validate query filters
      const filters = parseRunAuditFilters(req.query as Record<string, unknown>);

      // Check includeLogs flag (default true)
      const includeLogs = (() => {
        if (req.query.includeLogs === undefined) return true;
        if (typeof req.query.includeLogs === "string") {
          const val = req.query.includeLogs.toLowerCase();
          return val === "true" || val === "1";
        }
        if (typeof req.query.includeLogs === "boolean") {
          return req.query.includeLogs;
        }
        return true;
      })();

      // Determine the task ID for audit filtering
      // Use explicit taskId filter if provided, otherwise fall back to run's contextSnapshot.taskId
      const auditTaskId = (filters.taskId ?? run.contextSnapshot?.taskId ?? undefined) as string | undefined;

      // Query run-audit events
      const auditEvents = scopedStore.getRunAuditEvents({
        runId: req.params.runId,
        taskId: auditTaskId,
        domain: filters.domain,
        startTime: filters.startTime,
        endTime: filters.endTime,
        limit: filters.limit,
      });

      // Normalize events
      const normalizedAuditEvents = auditEvents.map(normalizeRunAuditEvent);

      // Group audit events by domain
      const auditByDomain: RunTimelineResponse["auditByDomain"] = {
        database: [],
        git: [],
        filesystem: [],
      };

      for (const event of normalizedAuditEvents) {
        if (event.domain === "database") {
          auditByDomain.database.push(event);
        } else if (event.domain === "git") {
          auditByDomain.git.push(event);
        } else if (event.domain === "filesystem") {
          auditByDomain.filesystem.push(event);
        }
      }

      // Build timeline entries
      const timelineEntries: TimelineEntry[] = [];

      // Add audit events to timeline
      for (const event of auditEvents) {
        timelineEntries.push(auditEventToTimelineEntry(event));
      }

      // Add agent logs to timeline if requested and we have a task ID
      if (includeLogs && run.startedAt) {
        const taskId = auditTaskId;
        if (taskId) {
          const logs = await scopedStore.getAgentLogsByTimeRange(
            taskId,
            run.startedAt,
            run.endedAt,
          );

          for (const log of logs) {
            timelineEntries.push(logEntryToTimelineEntry(log));
          }
        }
      }

      // Sort timeline deterministically
      timelineEntries.sort(compareTimelineEntries);

      const response: RunTimelineResponse = {
        run: {
          id: run.id,
          agentId: run.agentId,
          startedAt: run.startedAt,
          endedAt: run.endedAt ?? undefined,
          status: run.status,
          taskId: (auditTaskId ?? undefined) as string | undefined,
        },
        auditByDomain,
        counts: {
          auditEvents: normalizedAuditEvents.length,
          logEntries: includeLogs && auditTaskId ? (await scopedStore.getAgentLogsByTimeRange(
            auditTaskId,
            run.startedAt,
            run.endedAt,
          )).length : 0,
        },
        timeline: timelineEntries,
      };

      res.json(response);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      if ((err instanceof Error ? err.message : String(err)).includes("not found")) {
        throw notFound(err instanceof Error ? err.message : String(err));
      } else {
        rethrowAsApiError(err);
      }
    }
  });

}
