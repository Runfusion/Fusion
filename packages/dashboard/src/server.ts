import express from "express";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Task, TaskStore, MergeResult, AutomationStore, RoutineStore } from "@fusion/core";
import { ChatStore } from "@fusion/core";
import type { AuthStorageLike, ModelRegistryLike } from "./routes.js";
import { createApiRoutes } from "./routes.js";
import { createSSE } from "./sse.js";
import { rateLimit, RATE_LIMITS } from "./rate-limit.js";
import { ApiError, sendErrorResponse } from "./api-error.js";
import { getOrCreateProjectStore, evictAllProjectStores, setOnProjectFirstCreated } from "./project-store-resolver.js";
import { getTerminalService, STALE_SESSION_THRESHOLD_MS } from "./terminal-service.js";
import { WebSocketServer, type WebSocket } from "ws";
import { terminalSessionManager } from "./terminal.js";

import { WebSocketManager, type BadgeSnapshot } from "./websocket.js";
import type { BadgePubSub } from "./badge-pubsub.js";
import { createBadgePubSub, type BadgePubSubMessage } from "./badge-pubsub.js";
import {
  AiSessionStore,
  SESSION_CLEANUP_DEFAULT_MAX_AGE_MS,
  SESSION_CLEANUP_INTERVAL_MS,
} from "./ai-session-store.js";
import {
  setAiSessionStore as setPlanningAiSessionStore,
  rehydrateFromStore as rehydratePlanningSessions,
} from "./planning.js";
import {
  setAiSessionStore as setSubtaskAiSessionStore,
  rehydrateFromStore as rehydrateSubtaskSessions,
} from "./subtask-breakdown.js";
import {
  setAiSessionStore as setMissionAiSessionStore,
  rehydrateFromStore as rehydrateMissionSessions,
} from "./mission-interview.js";
import {
  setAiSessionStore as setMilestoneSliceAiSessionStore,
  rehydrateFromStore as rehydrateMilestoneSliceSessions,
} from "./milestone-slice-interview.js";
import { ChatManager } from "./chat.js";
import type { SkillsAdapter } from "./skills-adapter.js";
import { createAuthMiddleware } from "./auth-middleware.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_AI_SESSION_TTL_MS = SESSION_CLEANUP_DEFAULT_MAX_AGE_MS;
const MIN_AI_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_AI_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_AI_SESSION_CLEANUP_INTERVAL_MS = SESSION_CLEANUP_INTERVAL_MS;
const MIN_AI_SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_AI_SESSION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let aiSessionCleanupIntervalHandle: ReturnType<typeof setInterval> | undefined;

function clearAiSessionCleanupInterval(): void {
  if (!aiSessionCleanupIntervalHandle) {
    return;
  }
  clearInterval(aiSessionCleanupIntervalHandle);
  aiSessionCleanupIntervalHandle = undefined;
}

process.on("beforeExit", () => {
  clearAiSessionCleanupInterval();
});

/**
 * Scoped Realtime Contract
 * ------------------------
 * All realtime endpoints (/api/events, /api/ws, /api/tasks/:id/logs/stream,
 * /api/terminal/ws) MUST resolve project context using resolveScopedStore:
 *   1. If projectId is omitted, use the default store.
 *   2. If engineManager has an engine for the project, use its TaskStore.
 *   3. Otherwise fall back to getOrCreateProjectStore(projectId).
 *
 * Badge websocket channels MUST be keyed as `badge:{projectId}:{taskId}`
 * so overlapping task IDs cannot leak across projects.
 *
 * @see toBadgeChannel in websocket.ts for channel key format
 * @see extractPartsFromChannel in websocket.ts for channel key parsing
 */
export async function resolveScopedStore(
  projectId: string | undefined,
  store: TaskStore,
  engineManager?: import("@fusion/engine").ProjectEngineManager,
): Promise<TaskStore> {
  if (!projectId) {
    return store;
  }

  if (engineManager) {
    const engine = engineManager.getEngine(projectId);
    if (engine) {
      return engine.getTaskStore();
    }
  }

  return await getOrCreateProjectStore(projectId);
}

export interface ServerOptions {
  /** Optional ProjectEngine — when provided, subsystems (onMerge, automationStore,
   *  missionAutopilot, missionExecutionLoop, heartbeatMonitor) are derived from it.
   *  Explicit options still override engine-derived values.
   *  @deprecated Use engineManager instead for multi-project support. */
  engine?: import("@fusion/engine").ProjectEngine;
  /** ProjectEngineManager for uniform multi-project engine lifecycle.
   *  When provided, the server can resolve per-project engines for route handlers. */
  engineManager?: import("@fusion/engine").ProjectEngineManager;
  /** Custom merge handler — when provided, used instead of store.mergeTask */
  onMerge?: (taskId: string) => Promise<MergeResult>;
  /** When true, run API/websocket server only (skip frontend static assets + SPA fallback) */
  headless?: boolean;
  /** Maximum concurrent worktrees / execution slots (default 2) */
  maxConcurrent?: number;
  /** Optional GitHub token for PR operations — falls back to GITHUB_TOKEN env var */
  githubToken?: string;
  /** Optional AuthStorage instance for auth routes — if not provided, one is created internally */
  authStorage?: AuthStorageLike;
  /** Optional ModelRegistry instance for the models API — if not provided, the endpoint returns an empty list */
  modelRegistry?: ModelRegistryLike;
  /** Optional BadgePubSub adapter for cross-instance badge snapshot fan-out — if not provided, creates from env or falls back to in-memory */
  badgePubSub?: BadgePubSub;
  /** Optional AutomationStore for scheduled task management */
  automationStore?: AutomationStore;
  /** Optional RoutineStore for recurring task automation */
  routineStore?: RoutineStore;
  /** Optional RoutineRunner for triggering routine execution via heartbeat */
  routineRunner?: {
    triggerManual(routineId: string): Promise<import("@fusion/core").RoutineExecutionResult>;
    triggerWebhook(routineId: string, payload: Record<string, unknown>, signature?: string): Promise<import("@fusion/core").RoutineExecutionResult>;
  };
  /** Optional AiSessionStore — if not provided, one is created from the default store's database */
  aiSessionStore?: AiSessionStore;
  /** Optional MissionAutopilot for autonomous mission progression */
  missionAutopilot?: {
    watchMission(missionId: string): void;
    unwatchMission(missionId: string): void;
    isWatching(missionId: string): boolean;
    getAutopilotStatus(missionId: string): import("@fusion/core").AutopilotStatus;
    checkAndStartMission(missionId: string): Promise<void>;
    recoverStaleMission(missionId: string): Promise<void>;
    start(): void;
    stop(): void;
  };
  /** Optional MissionExecutionLoop for validation cycle handling */
  missionExecutionLoop?: {
    recoverActiveMissions(): Promise<{ recoveredCount: number }>;
    isRunning(): boolean;
  };
  /** Optional HeartbeatMonitor for triggering agent execution runs */
  heartbeatMonitor?: {
    /** Project root directory this monitor is bound to. Used for scope validation. */
    rootDir?: string;
    startRun(agentId: string, options?: { source: import("@fusion/core").HeartbeatInvocationSource; triggerDetail?: string; contextSnapshot?: Record<string, unknown> }): Promise<import("@fusion/core").AgentHeartbeatRun>;
    executeHeartbeat(options: {
      agentId: string;
      source: import("@fusion/core").HeartbeatInvocationSource;
      triggerDetail?: string;
      taskId?: string;
      triggeringCommentIds?: string[];
      triggeringCommentType?: "steering" | "task" | "pr";
      contextSnapshot?: Record<string, unknown>;
    }): Promise<import("@fusion/core").AgentHeartbeatRun>;
    stopRun(agentId: string): Promise<void>;
  };
  /** Optional PluginStore for plugin management routes */
  pluginStore?: import("@fusion/core").PluginStore;
  /** Optional PluginLoader for plugin lifecycle management */
  pluginLoader?: import("@fusion/core").PluginLoader;
  /** Optional PluginRunner for plugin hooks and tools */
  pluginRunner?: {
    getPluginRoutes(): Array<{ pluginId: string; route: import("@fusion/core").PluginRouteDefinition }>;
  };
  /** Optional ChatStore for chat session management */
  chatStore?: import("@fusion/core").ChatStore;
  /** Optional ChatManager for AI chat message handling */
  chatManager?: import("./chat.js").ChatManager;
  /**
   * Called once when a secondary project (identified by projectId query param)
   * is first accessed via a project-scoped API or SSE request.
   *
   * @deprecated This callback is a fast-path fallback for immediate engine
   * startup on project access. ProjectEngineManager.startReconciliation() is
   * the primary mechanism for ensuring all registered projects have engines
   * started — it runs without requiring any UI or API access. This callback
   * is NOT required for correctness; it only provides a potential optimization
   * for projects that are accessed before the next reconciliation tick.
   */
  onProjectFirstAccessed?: (projectId: string) => void;
  /** Optional SkillsAdapter for skills discovery, execution toggling, and catalog fetching */
  skillsAdapter?: SkillsAdapter;
  /** Daemon mode configuration with bearer token authentication.
   *  When provided, all API requests (except /api/health) require valid bearer token. */
  daemon?: { token: string };
}

type DashboardExpressApp = ReturnType<typeof express> & {
  terminalWsServer?: WebSocketServer | null;
  badgeWsServer?: WebSocketServer | null;
  badgeWsManager?: WebSocketManager | null;
  __fnWebSocketsAttached?: boolean;
};

function shouldForceLocalhostForTests(): boolean {
  return process.env.NODE_ENV === "test";
}

function normalizeListenArgsForTests(args: unknown[]): unknown[] {
  if (!shouldForceLocalhostForTests()) {
    return args;
  }

  if (args.length === 0) {
    return ["127.0.0.1"];
  }

  const [first, second] = args;
  const secondIsHost = typeof second === "string";
  const firstIsOptionsObject =
    typeof first === "object" && first !== null && !Array.isArray(first);

  if (firstIsOptionsObject || secondIsHost) {
    return args;
  }

  if (typeof first === "number") {
    return [first, "127.0.0.1", ...args.slice(1)];
  }

  if (typeof first === "string" && first.startsWith("/")) {
    return args;
  }

  return args;
}

function resolveBoundedMs(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function shouldScheduleAiSessionCleanup(): boolean {
  return process.env.NODE_ENV !== "test";
}

export function createServer(store: TaskStore, options?: ServerOptions): ReturnType<typeof express> {
  // ── Derive defaults from engine when provided (explicit options override) ──
  const engine = options?.engine;
  if (engine) {
    if (!options!.onMerge) {
      options = { ...options, onMerge: (taskId: string) => engine.onMerge(taskId) };
    }
    if (!options!.automationStore) {
      options = { ...options, automationStore: engine.getAutomationStore() };
    }
    if (!options!.missionAutopilot) {
      const ma = engine.getRuntime().getMissionAutopilot();
      if (ma) options = { ...options, missionAutopilot: ma };
    }
    if (!options!.missionExecutionLoop) {
      const mel = engine.getRuntime().getMissionExecutionLoop();
      if (mel) options = { ...options, missionExecutionLoop: mel };
    }
    if (!options!.heartbeatMonitor) {
      const hb = engine.getHeartbeatMonitor();
      if (hb) {
        options = {
          ...options,
          heartbeatMonitor: {
            rootDir: engine.getWorkingDirectory(),
            startRun: hb.startRun.bind(hb),
            executeHeartbeat: hb.executeHeartbeat.bind(hb),
            stopRun: hb.stopRun.bind(hb),
          },
        };
      }
    }
  }

  // Register callback for lazy engine startup on secondary projects
  if (options?.onProjectFirstAccessed) {
    setOnProjectFirstCreated(options.onProjectFirstAccessed);
  }

  const app = express();
  const mutationRateLimit = rateLimit(RATE_LIMITS.mutation);
  const setupRateLimit = rateLimit(RATE_LIMITS.api);
  const setupReadRateLimit = rateLimit(RATE_LIMITS.api);

  // Raw body buffer for webhook signature verification - must be before express.json()
  // Only applied to the webhook route
  app.use("/api/github/webhooks", express.raw({ type: "application/json" }));

  // Standard JSON parsing for all other routes
  app.use(express.json());

  // Daemon mode: bearer token authentication middleware
  // Auth is enabled when daemon option is provided OR FUSION_DAEMON_TOKEN env var is set
  // The middleware itself exempts /api/health for liveness probes
  const daemonToken = options?.daemon?.token ?? process.env.FUSION_DAEMON_TOKEN;
  if (daemonToken) {
    app.use(createAuthMiddleware(daemonToken));
  }

  // Initialize terminal service with project root
  getTerminalService(store.getRootDir());

  const isHeadless = options?.headless === true;

  // Serve built React app
  // Resolution order:
  //   1. FUSION_CLIENT_DIR env override (explicit)
  //   2. Next to process.execPath (bun-compiled binary: dist/fn + dist/client/)
  //   3. __dirname/../dist/client  (running from src/ via tsx/ts-node)
  //   4. __dirname/../client        (running from dist/ after tsc)
  const execDir = dirname(process.execPath);
  const clientDir = process.env.FUSION_CLIENT_DIR
    ? process.env.FUSION_CLIENT_DIR
    : existsSync(join(execDir, "client", "index.html"))
      ? join(execDir, "client")
      : existsSync(join(__dirname, "..", "dist", "client"))
        ? join(__dirname, "..", "dist", "client")
        : join(__dirname, "..", "client");

  if (!isHeadless) {
    app.use(express.static(clientDir));
  }

  // Rate limiting — stricter limit on SSE connections
  app.get("/api/events", rateLimit(RATE_LIMITS.sse), async (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const engineManager = options?.engineManager;

    if (!projectId) {
      createSSE(store, store.getMissionStore(), aiSessionStore, store.getPluginStore())(req, res);
      return;
    }

    try {
      // Prefer the engine's store when available — this ensures SSE listeners
      // attach to the same EventEmitter instance that the engine writes to,
      // rather than a separate store created by getOrCreateProjectStore.
      let scopedStore: TaskStore;
      if (engineManager) {
        const engine = engineManager.getEngine(projectId);
        scopedStore = engine?.getTaskStore() ?? await getOrCreateProjectStore(projectId);
      } else {
        scopedStore = await getOrCreateProjectStore(projectId);
      }
      createSSE(scopedStore, scopedStore.getMissionStore(), aiSessionStore, scopedStore.getPluginStore(), {
        projectId,
      })(req, res);
    } catch (err: unknown) {
      sendErrorResponse(res, 500, err instanceof Error ? err.message : "Failed to open project event stream");
    }
  });

  /**
   * Shared project-resolution helper for realtime endpoints.
   * Uses module-level resolveScopedStore with current closure context.
   */
  async function resolveProjectScopedStore(projectId: string | undefined): Promise<TaskStore> {
    return resolveScopedStore(projectId, store, options?.engineManager);
  }

  // Per-task SSE endpoint for live agent log streaming
  app.get("/api/tasks/:id/logs/stream", async (req, res) => {
    const taskId = req.params.id;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    // Resolve the store for this request:
    // - With projectId: use scoped store from engine or resolver (ensures multi-project isolation)
    // - Without projectId: use default store (preserves existing single-project behavior)
    //
    // Per-entry text and detail fields are serialized in full — there is no
    // SSE-level truncation.  The 500-entry cap is applied client-side in the
    // React hooks (useAgentLogs / useMultiAgentLogs).
    let scopedStore: TaskStore;
    try {
      scopedStore = await resolveProjectScopedStore(projectId);
    } catch {
      res.write(`event: error\ndata: ${JSON.stringify({ message: "Failed to resolve project store" })}\n\n`);
      res.end();
      return;
    }

    const onAgentLog = (entry: { taskId: string; text: string; type: string; timestamp: string }) => {
      if (entry.taskId !== taskId) return;
      res.write(`event: agent:log\ndata: ${JSON.stringify(entry)}\n\n`);
    };

    scopedStore.on("agent:log", onAgentLog);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      scopedStore.off("agent:log", onAgentLog);
    });
  });

  // Legacy Terminal SSE endpoint (deprecated, use WebSocket instead)
  app.get("/api/terminal/sessions/:id/stream", rateLimit(RATE_LIMITS.sse), (req, res) => {
    const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    const session = terminalSessionManager.getSession(sessionId);

    // If session doesn't exist, send error and close
    if (!session) {
      res.write(`event: terminal:error\ndata: ${JSON.stringify({ message: "Session not found" })}\n\n`);
      res.end();
      return;
    }

    // Send existing output immediately
    if (session.output.length > 0) {
      const existingOutput = session.output.join("");
      res.write(`event: terminal:output\ndata: ${JSON.stringify({ type: "stdout", data: existingOutput })}\n\n`);
    }

    // If session has already exited, send exit event
    if (session.exitCode !== null) {
      res.write(`event: terminal:exit\ndata: ${JSON.stringify({ exitCode: session.exitCode })}\n\n`);
      res.end();
      return;
    }

    // Listen for new output
    const onOutput = (event: import("./terminal.js").TerminalOutputEvent) => {
      if (event.sessionId !== sessionId) return;

      if (event.type === "exit") {
        res.write(`event: terminal:exit\ndata: ${JSON.stringify({ exitCode: event.exitCode })}\n\n`);
        res.end();
      } else {
        res.write(`event: terminal:output\ndata: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`);
      }
    };

    terminalSessionManager.on("output", onOutput);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      terminalSessionManager.off("output", onOutput);
    });
  });

  // Rate limiting — avoid throttling normal dashboard reads, which are often
  // driven by polling, but keep targeted limits for setup flows, writes, and SSE.
  app.use("/api", (req, res, next) => {
    const isSetupRead =
      req.method === "GET" && (
        req.path === "/browse-directory" ||
        req.path === "/setup-state" ||
        req.path === "/first-run-status"
      );

    const isSetupMutation =
      req.method === "POST" && (
        req.path === "/projects" ||
        req.path === "/projects/detect" ||
        req.path === "/complete-setup"
      );

    if (isSetupRead) {
      setupReadRateLimit(req, res, next);
      return;
    }

    if (isSetupMutation) {
      setupRateLimit(req, res, next);
      return;
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      mutationRateLimit(req, res, next);
      return;
    }

    next();
  });

  // Planning route diagnostics for production/runtime debugging. Disabled by default.
  if (process.env.FUSION_DEBUG_PLANNING_ROUTES === "1") {
    app.use("/api/planning", (req, _res, next) => {
      console.debug("[planning:request]", {
        method: req.method,
        path: req.path,
        originalUrl: req.originalUrl,
        contentType: req.headers["content-type"],
      });
      next();
    });
  }

  // Create AiSessionStore for background task persistence
  const aiSessionStore = options?.aiSessionStore ?? new AiSessionStore(store.getDatabase());
  aiSessionStore.recoverStaleSessions();
  setPlanningAiSessionStore(aiSessionStore);
  setSubtaskAiSessionStore(aiSessionStore);
  setMissionAiSessionStore(aiSessionStore);
  setMilestoneSliceAiSessionStore(aiSessionStore);

  const planningRehydratedCount = rehydratePlanningSessions(aiSessionStore);
  const subtaskRehydratedCount = rehydrateSubtaskSessions(aiSessionStore);
  const missionRehydratedCount = rehydrateMissionSessions(aiSessionStore);
  const milestoneSliceRehydratedCount = rehydrateMilestoneSliceSessions(aiSessionStore);
  const totalRehydrated =
    planningRehydratedCount + subtaskRehydratedCount + missionRehydratedCount + milestoneSliceRehydratedCount;
  if (totalRehydrated > 0) {
    console.log(
      `[server] Rehydrated ${planningRehydratedCount} planning, ${subtaskRehydratedCount} subtask, ${missionRehydratedCount} mission, ${milestoneSliceRehydratedCount} milestone/slice sessions from SQLite`,
    );
  }

  // Create ChatStore for chat session management
  const chatStore = options?.chatStore ?? new ChatStore(store.getFusionDir(), store.getDatabase());

  // Create ChatManager for AI chat message handling
  const chatManager = options?.chatManager ?? new ChatManager(chatStore, store.getRootDir());

  const runAiSessionCleanup = (maxAgeMs: number, source: "initial" | "scheduled") => {
    const result = aiSessionStore.cleanupStaleSessions(maxAgeMs);
    console.log(
      `[server] AI session cleanup (${source}): removed ${result.terminalDeleted} terminal, ${result.orphanedDeleted} orphaned sessions`,
    );
    return result;
  };

  const scheduleAiSessionCleanup = (cleanupIntervalMs: number, maxAgeMs: number) => {
    clearAiSessionCleanupInterval();
    aiSessionCleanupIntervalHandle = setInterval(() => {
      try {
        runAiSessionCleanup(maxAgeMs, "scheduled");
      } catch (err) {
        console.error("[server] Scheduled AI session cleanup failed", err);
      }
    }, cleanupIntervalMs);
    aiSessionCleanupIntervalHandle.unref?.();
  };

  if (shouldScheduleAiSessionCleanup()) {
    const loadSettings = (store as { getSettings?: () => Promise<{ aiSessionTtlMs?: number; aiSessionCleanupIntervalMs?: number }> }).getSettings;
    if (typeof loadSettings === "function") {
      void loadSettings
        .call(store)
        .then((settings) => {
          const ttlMs = resolveBoundedMs(
            settings.aiSessionTtlMs,
            DEFAULT_AI_SESSION_TTL_MS,
            MIN_AI_SESSION_TTL_MS,
            MAX_AI_SESSION_TTL_MS,
          );
          const cleanupIntervalMs = resolveBoundedMs(
            settings.aiSessionCleanupIntervalMs,
            DEFAULT_AI_SESSION_CLEANUP_INTERVAL_MS,
            MIN_AI_SESSION_CLEANUP_INTERVAL_MS,
            MAX_AI_SESSION_CLEANUP_INTERVAL_MS,
          );

          void Promise.resolve()
            .then(() => runAiSessionCleanup(ttlMs, "initial"))
            .catch((err) => {
              console.error("[server] Initial AI session cleanup failed", err);
            });

          scheduleAiSessionCleanup(cleanupIntervalMs, ttlMs);
        })
        .catch((err) => {
          console.warn("[server] Failed to load settings for AI session cleanup; using defaults", err);

          void Promise.resolve()
            .then(() => runAiSessionCleanup(DEFAULT_AI_SESSION_TTL_MS, "initial"))
            .catch((cleanupErr) => {
              console.error("[server] Initial AI session cleanup failed", cleanupErr);
            });

          scheduleAiSessionCleanup(
            DEFAULT_AI_SESSION_CLEANUP_INTERVAL_MS,
            DEFAULT_AI_SESSION_TTL_MS,
          );
        });
    } else {
      void Promise.resolve()
        .then(() => runAiSessionCleanup(DEFAULT_AI_SESSION_TTL_MS, "initial"))
        .catch((err) => {
          console.error("[server] Initial AI session cleanup failed", err);
        });

      scheduleAiSessionCleanup(
        DEFAULT_AI_SESSION_CLEANUP_INTERVAL_MS,
        DEFAULT_AI_SESSION_TTL_MS,
      );
    }
  }

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      version: process.env.npm_package_version ?? "0.4.0",
      uptime: Math.floor(process.uptime()),
    });
  });

  // REST API
  app.use("/api", createApiRoutes(store, { ...options, aiSessionStore, chatStore, chatManager, skillsAdapter: options?.skillsAdapter }));

  // API 404 Handler - Return JSON for unmatched API routes (instead of falling through to SPA)
  app.use("/api", (_req: express.Request, res: express.Response) => {
    sendErrorResponse(res, 404, "Not found");
  });

  // API Error Handling Middleware - MUST be after API routes but before SPA fallback
  // This ensures API errors return JSON instead of falling through to the SPA fallback (which returns HTML)
   
  app.use("/api", (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      return;
    }

    if (err instanceof ApiError) {
      sendErrorResponse(res, err.statusCode, err.message, { details: err.details });
      return;
    }

    const fallbackMessage = "Internal server error";
    const message =
      process.env.NODE_ENV === "production"
        ? fallbackMessage
        : err instanceof Error && err.message
          ? err.message
          : fallbackMessage;

    sendErrorResponse(res, 500, message);
  });

  if (!isHeadless) {
    // SPA fallback
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(join(clientDir, "index.html"));
    });
  }

  const dashboardApp = app as DashboardExpressApp;
  dashboardApp.terminalWsServer = null;
  dashboardApp.badgeWsServer = null;
  dashboardApp.badgeWsManager = null;
  dashboardApp.__fnWebSocketsAttached = false;

  const originalListen = dashboardApp.listen.bind(dashboardApp);
  dashboardApp.listen = ((...args: Parameters<typeof dashboardApp.listen>) => {
    const normalizedArgs = normalizeListenArgsForTests(args) as Parameters<typeof originalListen>;
    const server = originalListen(...normalizedArgs);

    server.once("close", () => {
      clearAiSessionCleanupInterval();
      aiSessionStore.stopScheduledCleanup();
    });

    if (!dashboardApp.__fnWebSocketsAttached) {
      dashboardApp.__fnWebSocketsAttached = true;
      setupTerminalWebSocket(dashboardApp, server, store, options);
      setupBadgeWebSocket(dashboardApp, server, store, options);
    }

    return server;
  }) as typeof dashboardApp.listen;

  return dashboardApp;
}

/**
 * Setup WebSocket terminal server
 * Call this after creating the HTTP server to attach WebSocket handling
 */
export function setupTerminalWebSocket(
  app: ReturnType<typeof express>,
  server: import("http").Server,
  store: TaskStore,
  options?: ServerOptions,
): void {
  const wss = new WebSocketServer({ noServer: true });

  // Default terminal service for stale eviction (uses default store's root dir)
  const defaultTerminalService = getTerminalService(store.getRootDir());

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", `http://${req.headers.host}`).pathname;
    if (pathname !== "/api/terminal/ws") {
      return;
    }

    wss.handleUpgrade(req, socket, head, (upgraded) => {
      wss.emit("connection", upgraded, req);
    });
  });

  // Store reference on app for access
  (app as DashboardExpressApp).terminalWsServer = wss;

  wss.on("connection", async (ws: WebSocket, req) => {
    // Parse query params from URL
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");
    const projectId = url.searchParams.get("projectId") ?? undefined;

    if (!sessionId) {
      ws.close(4000, "Missing sessionId");
      return;
    }

    // Resolve the scoped terminal service
    let terminalService: ReturnType<typeof getTerminalService>;
    let scopedRootDir: string;
    
    try {
      if (projectId) {
        // When projectId is provided, resolve the scoped store and get its root dir
        const scopedStore = await resolveScopedStore(projectId, store, options?.engineManager);
        scopedRootDir = scopedStore.getRootDir();
        terminalService = getTerminalService(scopedRootDir);
      } else {
        // Without projectId, use the default store's root dir
        scopedRootDir = store.getRootDir();
        terminalService = getTerminalService(scopedRootDir);
      }
    } catch (err) {
      console.error("[terminal] Failed to resolve project scope:", err);
      ws.close(4510, "Failed to resolve project scope");
      return;
    }

    const session = terminalService.getSession(sessionId);
    if (!session) {
      ws.close(4004, "Session not found");
      return;
    }

    // Security check: reject sessions that don't belong to this project's root
    // Session cwd must be within the resolved project root
    if (!session.cwd.startsWith(scopedRootDir)) {
      console.warn(`[terminal] Session ${sessionId} cwd ${session.cwd} does not belong to project root ${scopedRootDir}`);
      ws.close(4503, "Session does not belong to this project");
      return;
    }

    const MAX_MISSED_PONGS = 2; // Allow 2 missed pongs (~90s) before terminating

    // Track if connection is alive
    let isAlive = true;
    let missedPongs = 0; // Track consecutive missed pongs
    let dataUnsub: (() => void) | null = null;
    let exitUnsub: (() => void) | null = null;

    // Detect potentially stale sessions on reconnect
    const idleMs = Date.now() - session.lastActivityAt.getTime();
    if (idleMs > STALE_SESSION_THRESHOLD_MS) {
      console.warn(
        `[terminal] Session ${sessionId} reconnect after ${Math.round(idleMs / 1000)}s idle — PTY may be stale`
      );
    }

    // Send scrollback buffer first
    const scrollback = terminalService.getScrollbackAndClearPending(sessionId);
    if (scrollback) {
      ws.send(JSON.stringify({ type: "scrollback", data: scrollback }));
    }

    // Send connection info
    ws.send(JSON.stringify({
      type: "connected",
      shell: session.shell,
      cwd: session.cwd,
    }));

    // Subscribe to data events
    dataUnsub = terminalService.onData((id, data) => {
      if (id === sessionId && isAlive) {
        try {
          ws.send(JSON.stringify({ type: "data", data }));
        } catch {
          // WebSocket might be closing
        }
      }
    });

    // Subscribe to exit events
    exitUnsub = terminalService.onExit((id, exitCode) => {
      if (id === sessionId && isAlive) {
        try {
          ws.send(JSON.stringify({ type: "exit", exitCode }));
          const idleSec = id ? Math.round((Date.now() - (terminalService.getSession(id)?.lastActivityAt?.getTime() ?? Date.now())) / 1000) : 0;
          console.info(`[terminal] Session ${id} exited with code ${exitCode} (was ${idleSec}s idle)`);
        } catch {
          // WebSocket might be closing
        }
      }
    });

    // Heartbeat ping/pong
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        missedPongs++;
        if (missedPongs >= MAX_MISSED_PONGS) {
          console.warn(`[terminal] Connection dead after ${missedPongs} missed pongs, terminating`);
          ws.terminate();
          return;
        }
        console.info(`[terminal] Missed pong #${missedPongs}, waiting for response...`);
        return;
      }
      isAlive = false;
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        ws.terminate();
      }
    }, 30000);

    ws.on("pong", () => {
      isAlive = true;
      missedPongs = 0; // Reset on successful pong
    });

    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());

        switch (msg.type) {
          case "input":
            if (typeof msg.data === "string") {
              terminalService.write(sessionId, msg.data);
            }
            break;
          case "resize":
            if (typeof msg.cols === "number" && typeof msg.rows === "number") {
              terminalService.resize(sessionId, msg.cols, msg.rows);
            }
            break;
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "pong":
            isAlive = true;
            missedPongs = 0; // Reset on successful pong
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      isAlive = false;
      clearInterval(pingInterval);
      if (dataUnsub) dataUnsub();
      if (exitUnsub) exitUnsub();
      // Do NOT kill the PTY session on WebSocket close — the session should
      // survive transient disconnects and modal close/reopen cycles.  Sessions
      // are cleaned up through explicit kill paths (tab close, restart, shell
      // exit) or stale-session eviction.
    });

    ws.on("error", () => {
      isAlive = false;
      clearInterval(pingInterval);
      if (dataUnsub) dataUnsub();
      if (exitUnsub) exitUnsub();
      // Do NOT kill the PTY session on WebSocket error — same rationale as
      // close: the session should persist for reconnection attempts.
    });
  });

  // Periodic stale-session eviction (every 60 s) so that PTY sessions are
  // eventually cleaned up when clients disconnect permanently without going
  // through explicit kill paths.  The eviction threshold is defined by
  // TerminalService (default 5 minutes of inactivity).
  const staleEvictionInterval = setInterval(() => {
    try {
      defaultTerminalService.evictStaleSessions();
    } catch {
      // Ignore errors during periodic eviction
    }
  }, 60_000);

  // Stop eviction timer when the server shuts down
  server.once("close", () => {
    clearInterval(staleEvictionInterval);
  });

  console.log("Terminal WebSocket server mounted at /api/terminal/ws");
}

export function setupBadgeWebSocket(
  app: ReturnType<typeof express>,
  server: import("http").Server,
  store: TaskStore,
  options?: ServerOptions,
): void {
  const dashboardApp = app as DashboardExpressApp;
  const wsManager = new WebSocketManager();
  
  // Structured badge snapshot cache for local subscriptions and pub/sub sync
  // Maps "{projectId}:{taskId}" -> BadgeSnapshot with timestamp
  // Uses "default" for unscoped/default project
  const badgeSnapshots = new Map<string, BadgeSnapshot>();
  
  // Server instance ID for pub/sub deduplication
  const serverId = randomUUID();
  
  // Use injected badgePubSub or create from environment
  const badgePubSub = options?.badgePubSub ?? createBadgePubSub({ sourceId: serverId });
  void badgePubSub.start();

  // Track scoped stores for multi-project support
  const scopedStores = new Map<string, TaskStore>();
  
  // Helper to get or create a scoped store
  const getScopedStore = async (projectId: string): Promise<TaskStore> => {
    // Always use the default store for the "default" scope
    if (projectId === "default") {
      return store;
    }
    
    let scopedStore = scopedStores.get(projectId);
    if (scopedStore) {
      return scopedStore;
    }
    
    // Create scoped store
    scopedStore = await resolveScopedStore(projectId, store, options?.engineManager);
    scopedStores.set(projectId, scopedStore);
    return scopedStore;
  };

  // Prime cache with existing tasks from default store
  void store.listTasks({ slim: true, includeArchived: false }).then((tasks) => {
    for (const task of tasks) {
      badgeSnapshots.set(`default:${task.id}`, {
        prInfo: task.prInfo ?? null,
        issueInfo: task.issueInfo ?? null,
        timestamp: new Date().toISOString(),
      });
    }
  }).catch(() => {
    // Best-effort cache prime only
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", `http://${req.headers.host}`).pathname;
    if (pathname !== "/api/ws") {
      return;
    }

    wss.handleUpgrade(req, socket, head, (upgraded) => {
      wss.emit("connection", upgraded, req);
    });
  });

  dashboardApp.badgeWsServer = wss;
  dashboardApp.badgeWsManager = wsManager;

  /**
   * Broadcast a badge snapshot to subscribed clients within a project scope.
   */
  const broadcastBadgeSnapshot = (taskId: string, snapshot: BadgeSnapshot, projectId: string = "default"): void => {
    wsManager.broadcastBadgeUpdate(taskId, snapshot, projectId);
  };

  /**
   * Get or create scoped store and attach badge listeners.
   * Returns cleanup function.
   */
  const attachScopedListeners = async (
    projectId: string,
    scopedStore: TaskStore
  ): Promise<() => void> => {
    const scopeKey = projectId === "default" ? "default" : projectId;

    const onTaskUpdated = (task: Task) => {
      const cacheKey = `${scopeKey}:${task.id}`;
      const previousSnapshot = badgeSnapshots.get(cacheKey);
      const nextSnapshot: BadgeSnapshot = {
        prInfo: task.prInfo ?? null,
        issueInfo: task.issueInfo ?? null,
        timestamp: new Date().toISOString(),
      };
      
      // Update local cache immediately
      badgeSnapshots.set(cacheKey, nextSnapshot);

      // Check if badge data actually changed
      if (snapshotsEqual(previousSnapshot, nextSnapshot)) {
        return;
      }

      // Always publish to shared bus (even if no local subscribers)
      // This ensures other instances receive the update
      const pubSubMessage: BadgePubSubMessage = {
        sourceId: serverId,
        projectId,
        taskId: task.id,
        timestamp: nextSnapshot.timestamp,
        prInfo: nextSnapshot.prInfo,
        issueInfo: nextSnapshot.issueInfo,
      };
      void badgePubSub.publish(pubSubMessage);

      // Broadcast to local websocket subscribers if any
      if (wsManager.getSubscriptionCount(task.id, projectId) > 0) {
        broadcastBadgeSnapshot(task.id, nextSnapshot, projectId);
      }
    };

    const onTaskCreated = (task: Task) => {
      const cacheKey = `${scopeKey}:${task.id}`;
      badgeSnapshots.set(cacheKey, {
        prInfo: task.prInfo ?? null,
        issueInfo: task.issueInfo ?? null,
        timestamp: new Date().toISOString(),
      });
    };

    const onTaskDeleted = (task: Task) => {
      const cacheKey = `${scopeKey}:${task.id}`;
      badgeSnapshots.delete(cacheKey);
    };

    scopedStore.on("task:updated", onTaskUpdated);
    scopedStore.on("task:created", onTaskCreated);
    scopedStore.on("task:deleted", onTaskDeleted);

    return () => {
      scopedStore.off("task:updated", onTaskUpdated);
      scopedStore.off("task:created", onTaskCreated);
      scopedStore.off("task:deleted", onTaskDeleted);
    };
  };

  // Store cleanup functions for scoped listeners
  const scopedCleanups = new Map<string, () => void>();

  // Attach listeners to default store
  void (async () => {
    const cleanup = await attachScopedListeners("default", store);
    scopedCleanups.set("default", cleanup);
  })();

  /**
   * Ensure scoped listeners are attached for a project.
   */
  const ensureScopedListeners = async (projectId: string): Promise<void> => {
    if (scopedCleanups.has(projectId)) {
      return;
    }
    
    const scopedStore = await getScopedStore(projectId);
    const cleanup = await attachScopedListeners(projectId, scopedStore);
    scopedCleanups.set(projectId, cleanup);
  };

  // Handle remote badge updates from other instances via pub/sub
  badgePubSub.on("message", (message: BadgePubSubMessage) => {
    // Use provided projectId or default scope
    const projectId = message.projectId ?? "default";
    const cacheKey = `${projectId}:${message.taskId}`;
    
    // Update local cache with remote snapshot
    const remoteSnapshot: BadgeSnapshot = {
      prInfo: message.prInfo,
      issueInfo: message.issueInfo,
      timestamp: message.timestamp,
    };
    badgeSnapshots.set(cacheKey, remoteSnapshot);

    // Rebroadcast to local websocket subscribers
    // (No need to check for echo - pub/sub adapter already filtered our own messages)
    if (wsManager.getSubscriptionCount(message.taskId, projectId) > 0) {
      broadcastBadgeSnapshot(message.taskId, remoteSnapshot, projectId);
    }
  });

  wsManager.on("subscription:changed", (taskId, subscriberCount, projectId) => {
    // Send cached snapshot to late subscriber if available
    // This ensures a client subscribing after a remote update still sees the latest state
    if (subscriberCount > 0) {
      const cacheKey = `${projectId}:${taskId}`;
      const cachedSnapshot = badgeSnapshots.get(cacheKey);
      if (cachedSnapshot) {
        broadcastBadgeSnapshot(taskId, cachedSnapshot, projectId);
      }
    }
  });

  wss.on("connection", (ws: WebSocket, req) => {
    // Parse projectId from URL query params
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const projectId = url.searchParams.get("projectId") ?? "default";
    
    // Ensure scoped listeners are attached for this project
    void ensureScopedListeners(projectId);
    
    // Add client bound to this project scope
    wsManager.addClient(ws, randomUUID(), projectId);
  });

  server.once("close", () => {
    // Clean up all scoped listeners
    for (const cleanup of scopedCleanups.values()) {
      cleanup();
    }
    scopedCleanups.clear();

    for (const scopedStore of scopedStores.values()) {
      // Don't close the default store - it's managed externally
      if (scopedStore !== store) {
        scopedStore.stopWatching?.();
        scopedStore.close?.();
      }
    }
    scopedStores.clear();

    for (const client of wss.clients) {
      client.terminate();
    }

    wsManager.dispose();
    void badgePubSub.dispose();
    wss.close();
    // Clean up cached project-scoped stores (stop watchers, close DB connections)
    evictAllProjectStores();
    dashboardApp.terminalWsServer = null;
    dashboardApp.badgeWsServer = null;
    dashboardApp.badgeWsManager = null;
    dashboardApp.__fnWebSocketsAttached = false;
  });
}

/** Compare two badge snapshots for equality */
function snapshotsEqual(a: BadgeSnapshot | undefined, b: BadgeSnapshot | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  
  // Compare prInfo
  if (a.prInfo?.url !== b.prInfo?.url) return false;
  if (a.prInfo?.status !== b.prInfo?.status) return false;
  if (a.prInfo?.number !== b.prInfo?.number) return false;
  if (a.prInfo?.title !== b.prInfo?.title) return false;
  
  // Compare issueInfo
  if (a.issueInfo?.url !== b.issueInfo?.url) return false;
  if (a.issueInfo?.state !== b.issueInfo?.state) return false;
  if (a.issueInfo?.number !== b.issueInfo?.number) return false;
  if (a.issueInfo?.title !== b.issueInfo?.title) return false;
  
  return true;
}
