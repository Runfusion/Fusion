import express, { type Router } from "express";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSecureServer as createHttp2SecureServer, type Http2SecureServer } from "node:http2";
import type { Server as HttpServer } from "node:http";
import type {
  Task,
  TaskStore,
  MergeResult,
  AutomationStore,
  RoutineStore,
  CentralCore,
  MessageStore,
  AgentLogEntry,
  TaskIdIntegrityReport,
} from "@fusion/core";
import { AgentStore, ChatStore, setRunningAgentCountSource } from "@fusion/core";
import type { AuthStorageLike, ModelRegistryLike } from "./routes.js";
import { createApiRoutes } from "./routes.js";
import { createSSE, disconnectSSEClient, markSSEClientAlive } from "./sse.js";
import { rateLimit, RATE_LIMITS } from "./rate-limit.js";
import { ApiError, sendErrorResponse } from "./api-error.js";
import {
  countRunningAgentsInRegisteredProjectStores,
  countRunningAgentsInStore,
  getOrCreateProjectStore,
  evictAllProjectStores,
  setOnProjectFirstCreated,
} from "./project-store-resolver.js";
import { getOrCreateScopedChatStore } from "./chat-project-services.js";
import { getTerminalService, STALE_SESSION_THRESHOLD_MS } from "./terminal-service.js";
import { WebSocketServer, type WebSocket } from "ws";
import { terminalSessionManager } from "./terminal.js";

import { WebSocketManager, type BadgeSnapshot } from "./websocket.js";
import type { BadgePubSub } from "./badge-pubsub.js";
import { createBadgePubSub, type BadgePubSubMessage } from "./badge-pubsub.js";
import { createRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js";
import { registerGithubTrackingHook } from "./github-tracking-hook.js";
import { registerBeforeExitCleanup } from "./process-lifecycle.js";
import { createTerminalWebSocketDiagnostics } from "./terminal-websocket-diagnostics.js";
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
import { ChatManager, TASK_PLANNER_CHAT_AGENT_ID_PREFIX } from "./chat.js";
import { CliChatSessionRunner } from "./cli-chat.js";
import { stopAllDevServers } from "./dev-server-routes.js";
import type { SkillsAdapter } from "./skills-adapter.js";
import { createAuthMiddleware, authenticateUpgradeRequest, getDaemonToken } from "./auth-middleware.js";
import { setupCliSessionWebSocket } from "./cli-session-ws.js";
import { createCliSessionsRouter } from "./routes/cli-sessions.js";
import { getProjectIdFromRequest, resolveStoreForProjectId } from "./routes/context.js";
import type { CliRelaunchRegistry } from "./cli-session-transport.js";
import { validateRemoteAuthToken } from "./remote-auth.js";
import { getCliPackageVersion, isUnresolvedCliPackageVersion } from "./cli-package-version.js";
import {
  dayHasSamples,
  fileScopeInvariantFailuresPerDay,
  inReviewDurationMetrics,
  inReviewFailureRate7d,
  mergeAttemptsPerMergedTask,
  postMergeAuditFailuresPerDay,
  recoverAlreadyMergedReviewTasksRecoveriesPerDay,
} from "./reliability-metrics.js";
import { loadViewChunkManifest, type ViewChunkManifestEntry } from "./view-chunk-manifest.js";
import { maybeStartOtelExporter, type OtelExporterHandle } from "./otel-exporter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildViewPreloadInjection(chunkMap: Record<string, ViewChunkManifestEntry>): string {
  const serializedChunkMap = JSON.stringify(chunkMap).replace(/<\//g, "<\\/");
  /*
  FNXC:CommandCenterStyling 2026-06-19-09:43:
  The served dashboard may open directly into a persisted lazy view before React's dynamic import runs. Inject both the modulepreload and stylesheet links from Vite's manifest so Command Center and every other co-located-CSS lazy view have their CSS requested on first paint, while in-app navigation remains owned by Vite's __vitePreload runtime.
  */
  return `<script>window.__FUSION_VIEW_CHUNKS__=${serializedChunkMap};(()=>{try{const chunkMap=window.__FUSION_VIEW_CHUNKS__||{};const projectId=localStorage.getItem("kb-dashboard-current-project");const scopedKey=projectId?"kb:"+projectId+":kb-dashboard-task-view":null;let taskView=(scopedKey&&localStorage.getItem(scopedKey))||localStorage.getItem("kb-dashboard-task-view");if(taskView==="devserver")taskView="dev-server";if(taskView==="roadmaps")taskView="board";if(typeof taskView!=="string"||taskView.startsWith("plugin:"))return;const chunkEntry=chunkMap[taskView];if(!chunkEntry)return;const chunkPath=typeof chunkEntry==="string"?chunkEntry:chunkEntry.file;const cssPaths=Array.isArray(chunkEntry.css)?chunkEntry.css:[];for(const cssPath of cssPaths){if(!cssPath)continue;const cssLink=document.createElement("link");cssLink.rel="stylesheet";cssLink.href=cssPath;document.head.appendChild(cssLink);}if(!chunkPath)return;const link=document.createElement("link");link.rel="modulepreload";link.href=chunkPath;link.crossOrigin="";document.head.appendChild(link);}catch{}})();</script>`;
}

function parseVersion(version: string): number[] {
  return version
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0));
}

function buildTaskIdIntegrityHealth(report: TaskIdIntegrityReport) {
  return {
    status: report.status,
    checkedAt: report.checkedAt,
    anomalies: report.anomalies,
    recommendedAction:
      report.status === "anomaly"
        ? "Pause task delegation, inspect the affected task IDs, and run the allocator audit before creating new tasks."
        : null,
  };
}

function buildHealthPayload(args: {
  database: ReturnType<TaskStore["getDatabaseHealth"]>;
  taskIdIntegrityReport: ReturnType<TaskStore["getTaskIdIntegrityReport"]>;
  cliPackageVersion: string;
  engineAvailable: boolean;
}) {
  const { database, cliPackageVersion, engineAvailable } = args;
  const taskIdIntegrity = buildTaskIdIntegrityHealth(args.taskIdIntegrityReport);
  return {
    status: !database.healthy || database.corruptionDetected || taskIdIntegrity.status === "anomaly" ? "degraded" : "ok",
    version: cliPackageVersion,
    uptime: Math.floor(process.uptime()),
    /*
     * FNXC:DashboardHealth 2026-06-20-22:11:
     * The dashboard must distinguish "engine not started" from "engine paused" so UI-only launches can show remediation instructions instead of leaving users to infer why automation cannot run.
     */
    engine: {
      available: engineAvailable,
    },
    database,
    taskIdIntegrity,
  };
}

function isRemoteVersionNewer(remoteVersion: string, currentVersion: string): boolean {
  const remote = parseVersion(remoteVersion);
  const current = parseVersion(currentVersion);
  const maxLength = Math.max(remote.length, current.length, 3);

  for (let i = 0; i < maxLength; i += 1) {
    const remotePart = remote[i] ?? 0;
    const currentPart = current[i] ?? 0;

    if (remotePart > currentPart) {
      return true;
    }

    if (remotePart < currentPart) {
      return false;
    }
  }

  return false;
}

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

registerBeforeExitCleanup(() => {
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
  launchProjectId?: string,
  // FNXC:CentralProjectIdentity 2026-07-13-23:55: thread the caller's ServerOptions so
  // the shared one-time launch-dir fallback warning routes through runtimeLogger
  // instead of console.warn and isn't consumed on the unstructured sink first.
  options?: ServerOptions,
): Promise<TaskStore> {
  /*
  FNXC:CentralProjectIdentity 2026-07-14-00:15:
  Realtime scoped-store resolution delegates to the SINGLE shared id-based core
  (routes/context.ts resolveStoreForProjectId) so the realtime path and route path
  can never drift. This exported signature (separate engineManager/launchProjectId
  params) is retained for caller compatibility; callers derive both from `options`
  (engineManager = options.engineManager, launchProjectId = options.engine.getProjectId()),
  so folding `projectId ?? launchProjectId` into the shared core is equivalent.
  Note: engineManager/launchProjectId params below are consumed via `options` inside
  the shared core; they remain in the signature only for backwards compatibility.
  */
  void engineManager;
  void launchProjectId;
  return resolveStoreForProjectId(projectId ?? launchProjectId, store, options);
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
  /** Optional HybridExecutor orchestration context for multi-project runtime plumbing. */
  hybridExecutor?: import("@fusion/engine").HybridExecutor;
  /**
   * Resolver for the engine-held CLI-agent telemetry hub (U17 hook route).
   * Given a request's projectId (if any) and the target session id, returns the
   * in-process TelemetryHub that owns that session's token registry, or undefined
   * when no hub / session is live. The hook route validates the per-session token
   * against this hub and forwards validated payloads to `hub.ingest`. Injected
   * here (rather than reached through the engine) so the engine↔dashboard wiring
   * can be supplied by later units and stubbed in tests. */
  cliAgentHubResolver?: (
    projectId: string | undefined,
    sessionId: string,
  ) => import("@fusion/engine").TelemetryHub | undefined;
  /** Shared CentralCore instance used by the engine manager.
   *  Routes that mutate central runtime state should use this instance so
   *  in-process listeners (for example global concurrency changes) are notified. */
  centralCore?: CentralCore;
  /** Custom merge handler — when provided, used instead of store.mergeTask */
  onMerge?: (taskId: string) => Promise<MergeResult>;
  /** When true, run API/websocket server only (skip frontend static assets + SPA fallback) */
  headless?: boolean;
  /** Maximum concurrent worktrees / execution slots (default 2) */
  maxConcurrent?: number;
  /** Optional GitHub token for PR operations — falls back to GITHUB_TOKEN env var */
  githubToken?: string;
  /**
   * Optional AuthStorage instance for auth routes. If not provided explicitly and an `engine`
   * is provided, one is derived from `engine.getAuthStorage()` (see the engine-derivation
   * block below); explicit `authStorage` always overrides the engine-derived value.
   *
   * FNXC:ProviderAuth 2026-07-09-00:00:
   * FN-7747 / #1948: the engine-derived instance is the RAW createFusionAuthStorage() (no
   * API-key/custom-provider wrapping), so it restores credential *persistence* but not the
   * full provider catalog — hosts needing the full catalog (e.g. the desktop app's
   * seedDashboardProviders() output) must still pass their own wrapped `authStorage` here,
   * exactly as packages/desktop already does. This fallback exists so that a host which
   * wires an `engine` but forgets `authStorage` does not silently regress into
   * register-auth-routes.ts's "Authentication is not configured" throw.
   */
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
    triggerManual(routineId: string, liveCallbacks?: {
      onStep?: (data: Record<string, unknown>) => void;
      onText?: (delta: string) => void;
      onToolStart?: (name: string, args?: Record<string, unknown>) => void;
      onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
    }): Promise<import("@fusion/core").RoutineExecutionResult>;
    triggerWebhook(routineId: string, payload: Record<string, unknown>, signature?: string): Promise<import("@fusion/core").RoutineExecutionResult>;
  };
  /** Optional AiSessionStore — if not provided, one is created from the default store's database */
  aiSessionStore?: AiSessionStore;
  /**
   * Optional CLI agent session transport dependencies (CLI Agent Executor, U10).
   * When provided, the server mounts the cli-sessions REST routes and the
   * distinct `/api/cli-sessions/ws` attach handler. Wiring the engine-owned
   * CliSessionManager/store into this dep happens in a later unit; until then
   * the transport is inert unless explicitly supplied (e.g. in tests).
   */
  cliSessionTransport?: import("./cli-session-transport.js").CliSessionTransportDeps & {
    ticketStore: import("./cli-session-transport.js").AttachTicketStore;
    attributionLog: import("./cli-session-transport.js").CliInputAttributionLog;
    confirmAdvance: import("./cli-session-transport.js").CliConfirmAdvanceRegistry;
    relaunch: import("./cli-session-transport.js").CliRelaunchRegistry;
    extraAllowedOrigins?: string[];
  };
  /** Optional MissionAutopilot for autonomous mission progression */
  missionAutopilot?: {
    watchMission(missionId: string): void;
    unwatchMission(missionId: string): void;
    isWatching(missionId: string): boolean;
    // FNXC:MissionStore 2026-06-28-12:45: getAutopilotStatus is async (union store).
    getAutopilotStatus(missionId: string): Promise<import("@fusion/core").AutopilotStatus>;
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
  selfHealingManager?: {
    rootDir: string;
    reconcileInReviewBranchRebind: (opts?: { includeTaskIds?: Set<string> }) => Promise<import("@fusion/engine").RebindResult>;
    getActiveMergeTaskId: () => string | null;
  };
  /** Optional PluginStore for plugin management routes */
  pluginStore?: import("@fusion/core").PluginStore;
  /** Optional PluginLoader for plugin lifecycle management */
  pluginLoader?: import("@fusion/core").PluginLoader;
  /** Optional PluginRunner for plugin hooks, routes, and lifecycle operations */
  pluginRunner?: {
    getPluginRoutes(): Array<{ pluginId: string; route: import("@fusion/core").PluginRouteDefinition }>;
    getPluginWorkflowStepTemplates?(): Array<{ pluginId: string; template: import("@fusion/core").WorkflowStepTemplate }>;
    getRuntimeById?(runtimeId: string): unknown;
    createRuntimeContext?(pluginId: string): Promise<unknown>;
    /*
    FNXC:ChatSkills 2026-06-16-19:10:
    The dashboard passes this structural runner into ChatManager, which needs optional plugin skill discovery so chat can load enabled plugin skills such as ce-debug.
    */
    getPluginSkills?(): Array<{ pluginId: string; pluginRoot?: string; skill: { skillId?: string; name: string; description?: string; enabled?: boolean; skillFiles?: string[] } }>;
    reloadPlugin?(pluginId: string): Promise<unknown>;
    checkPluginSetup?(pluginId: string): Promise<import("@fusion/core").PluginSetupCheckResult>;
    installPluginSetup?(pluginId: string): Promise<void | { success: boolean; error?: string }>;
    uninstallPluginSetup?(pluginId: string): Promise<void | { success: boolean; error?: string }>;
    getPluginSetupInfo?(): Array<{
      pluginId: string;
      manifest: import("@fusion/core").PluginSetupManifest;
      hooks: import("@fusion/core").PluginSetupHooks;
    }>;
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
  /**
   * Called after a project is successfully registered via POST /api/projects
   * (dashboard-initiated project add). Invoked with the registered project's
   * path *after* activation but *before* the response is sent to the client.
   *
   * Consumers use this to perform side-effects that belong to project setup
   * (e.g. installing the fusion Claude-skill into `.claude/skills/fusion/`
   * when pi-claude-cli is configured). Failures should be swallowed by the
   * callback — they must not cause the HTTP response to fail.
   */
  onProjectRegistered?: (project: { id: string; name: string; path: string }) => void;
  /**
   * Called when the user toggles the `useClaudeCli` global setting via
   * PUT /api/settings/global. Invoked only on an actual transition (prev
   * !== next). Consumers use this to run project-wide setup — most notably,
   * installing the fusion Claude-skill into every registered project's
   * `.claude/skills/fusion/` when the toggle flips on, so the user doesn't
   * have to wait for a server restart to see the effect.
   *
   * Failures should be swallowed by the callback — they must not cause the
   * settings PUT to fail.
   */
  onUseClaudeCliToggled?: (prev: boolean, next: boolean) => void;
  /**
   * Lazily install a bundled runtime plugin (e.g. Hermes/OpenClaw/Paperclip
   * runtimes) the first time the user clicks Save in Settings. The dashboard
   * has no knowledge of the on-disk bundle layout, so the host (CLI) injects
   * this hook. Returns true if the plugin is now registered (either freshly
   * installed or already present), false if the bundle could not be resolved
   * (e.g. plugin id is unknown) so the route can fall through to its standard
   * "plugin not found" error.
   */
  ensureBundledPluginInstalled?: (pluginId: string) => Promise<boolean>;
  /**
   * Returns the host's last-observed resolution of the bundled
   * `@fusion/pi-claude-cli` extension. Populated by serve/daemon/dashboard
   * at startup after calling `resolveClaudeCliExtensionPaths`.
   *
   * The shape intentionally mirrors `ClaudeCliExtensionResolution` from the
   * CLI package but is described structurally so dashboard doesn't need to
   * depend on `@runfusion/fusion`.
   *
   * Returns `null` when the host hasn't evaluated the setting yet (very
   * early startup) — callers should treat null as "unknown, try again".
   */
  getClaudeCliExtensionStatus?: () =>
    | {
        status: "ok" | "not-installed" | "missing-entry" | "error";
        path?: string;
        packageVersion?: string;
        reason?: string;
      }
    | null;
  /**
   * Called when the user toggles the `useDroidCli` global setting via
   * PUT /api/settings/global. Invoked only on an actual transition (prev
   * !== next). Consumers use this to run project-wide setup for Droid CLI
   * integrations without requiring a server restart.
   *
   * Failures should be swallowed by the callback — they must not cause the
   * settings PUT to fail.
   */
  onUseDroidCliToggled?: (prev: boolean, next: boolean) => void;
  /** Called when the user toggles the `useLlamaCpp` global setting. */
  onUseLlamaCppToggled?: (prev: boolean, next: boolean) => void;
  /** Optional hook fired after a successful API-key save. */
  onApiKeySaved?: (providerId: string) => Promise<{
    registeredCount: number;
    reason?: "no-models-from-cli" | "cli-failed" | "disabled-by-settings";
    error?: string;
  } | void>;
  /**
   * Returns the host's last-observed resolution of the bundled `droid-cli`
   * extension wiring. Populated by serve/daemon/dashboard startup checks.
   *
   * The shape intentionally mirrors the Claude CLI extension status shape so
   * provider cards and auth routes can consume a consistent contract.
   *
   * Returns `null` when the host hasn't evaluated the setting yet (very
   * early startup) — callers should treat null as "unknown, try again".
   */
  getDroidCliExtensionStatus?: () =>
    | {
        status: "ok" | "not-installed" | "missing-entry" | "error";
        path?: string;
        packageVersion?: string;
        reason?: string;
      }
    | null;
  /** Returns the host's last-observed resolution of the bundled
   * `@fusion/pi-llama-cpp` extension wiring. Populated by startup checks.
   */
  getLlamaCppExtensionStatus?: () =>
    | {
        status: "ok" | "not-installed" | "missing-entry" | "error";
        path?: string;
        packageVersion?: string;
        reason?: string;
      }
    | null;
  /** Optional SkillsAdapter for skills discovery, execution toggling, and catalog fetching */
  skillsAdapter?: SkillsAdapter;
  /** Daemon mode configuration with bearer token authentication.
   *  When provided, all API requests (except /api/health) require valid bearer token. */
  daemon?: { token: string };
  /** Explicitly disable bearer-token auth, ignoring FUSION_DAEMON_TOKEN /
   *  FUSION_DASHBOARD_TOKEN env vars. Used by `fn dashboard --no-auth` so a
   *  stale token in a project .env doesn't silently override the flag. */
  noAuth?: boolean;
  /** Optional runtime logger for server/routes diagnostics.
   *  Defaults to a console-backed logger scoped to `server` when omitted. */
  runtimeLogger?: RuntimeLogger;
  /** Optional TLS credentials. When provided, the server is served over HTTP/2
   *  with HTTP/1.1 fallback (allowHTTP1:true) — this lifts the browser's
   *  per-origin connection cap so long-lived SSE streams no longer starve
   *  regular API fetches. WebSocket upgrades continue to work because HTTP/1.1
   *  clients are still accepted. */
  https?: {
    cert: string | Buffer;
    key: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>;
  };
  /*
   * FNXC:PostgresHealth 2026-06-24-16:00:
   * Optional PostgreSQL health layer. When provided, the /api/health and
   * /api/health/refresh endpoints use PostgreSQL-native health checks
   * (connectivity probe, schema drift, task-ID integrity) instead of the
   * SQLite-specific integrity_check path. This is the integration seam
   * between the async PostgreSQL data layer and the dashboard health surface.
   * When absent, the endpoints fall back to the legacy SQLite health checks
   * via store.getDatabaseHealth().
   */
  postgresHealthLayer?: import("@fusion/core").AsyncDataLayer;
  /*
  FNXC:SystemPanel 2026-07-12-11:15:
  Host-process control surface for the dashboard System panel (Command Center →
  System). The host CLI injects these; the /api/system routes consume them.
  `requestRestart` returns false when no supervising parent will respawn the
  process (then the UI disables restart actions). `sourceWorkspaceRoot` is set
  only when running from a Fusion source checkout, which gates the
  "Rebuild & restart" controls.
  */
  systemControl?: {
    supervised: boolean;
    requestRestart: (reason: string) => boolean;
    sourceWorkspaceRoot?: string;
  };
  /** Bounded host-process log history + live tail for the System panel log viewer. */
  systemLogs?: {
    getRecent(limit?: number): SystemLogEntry[];
    subscribe(listener: (entry: SystemLogEntry) => void): () => void;
  };
}

/** System panel log entry shape (mirrors the CLI log sink's ring buffer). */
export interface SystemLogEntry {
  timestamp: Date;
  level: "info" | "warn" | "error";
  message: string;
  prefix?: string;
}

function hasDashboardEngine(options?: ServerOptions): boolean {
  if (options?.engine) return true;
  const manager = options?.engineManager;
  if (!manager) return false;
  /*
   * FNXC:DashboardHealth 2026-06-21-03:30:
   * Engine availability must reflect machine-level truth, not only engines
   * owned by this dashboard process. `hasRunningEngine` counts engines owned
   * by this process AND engines owned by another fusion process on the machine
   * (detected via the singleton lock); without the latter a UI-only launch
   * alongside an already-running engine shows a false "engine not running"
   * banner.
   *
   * FNXC:DesktopEngineAvailability 2026-07-03-16:15:
   * Desktop embedded local mode creates modern ProjectEngineManager before any project engine may exist.
   * Treating an empty owned-engine map as dashboard-only makes the app shell show restart-Fusion remediation while the same manager is still starting, reconciling, or able to lazily ensure the selected project engine. A manager with machine-level liveness support therefore means automation is available at the process level; project-scoped disconnected/starting details stay on /api/engine/status. Older manager test doubles without that method retain the historical owned-engine fallback.
   */
  if (typeof manager.hasRunningEngine === "function") {
    return true;
  }
  const engines = manager.getAllEngines?.();
  return Boolean(engines && engines.size > 0);
}

export type EngineStatusReason = "dashboard-only" | "no-project";

export interface EngineStatusPayload {
  connected: boolean;
  starting: boolean;
  canStart: boolean;
  reason?: EngineStatusReason;
  projectId?: string;
}

function buildEngineStatusPayload(projectId: string | undefined, options?: ServerOptions): EngineStatusPayload {
  const engineManager = options?.engineManager;
  const base = projectId ? { projectId } : {};

  if (!engineManager) {
    return {
      connected: false,
      starting: false,
      canStart: false,
      reason: "dashboard-only",
      ...base,
    };
  }

  if (!projectId) {
    return {
      connected: false,
      starting: false,
      canStart: false,
      reason: "no-project",
    };
  }

  const engine = engineManager.getEngine(projectId);
  /*
   * FNXC:EngineStatusBanner 2026-06-22-00:00:
   * The dashboard needs a project-scoped distinction between a missing engine and an engine start already in flight. `has(projectId) && !getEngine(projectId)` mirrors ProjectEngineManager's transient starting map so the UI can disable duplicate Start engine attempts while reconciliation or a prior click is still creating the engine.
   */
  return {
    connected: Boolean(engine),
    starting: Boolean(engineManager.has(projectId) && !engine),
    canStart: true,
    projectId,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function normalizeErrorForLog(err: unknown): {
  error: string;
  errorName?: string;
  errorMessage: string;
  errorStack?: string;
} {
  if (err instanceof Error) {
    return {
      error: err.message,
      errorName: err.name,
      errorMessage: err.message,
      errorStack: err.stack,
    };
  }

  const fallback = String(err);
  return {
    error: fallback,
    errorMessage: fallback,
  };
}

/**
 * Resolve TLS credentials from environment variables, if configured.
 *
 * Reads either inline PEM material (`FUSION_TLS_CERT` / `FUSION_TLS_KEY`) or
 * file paths (`FUSION_TLS_CERT_FILE` / `FUSION_TLS_KEY_FILE`). `FUSION_TLS_CA`
 * / `FUSION_TLS_CA_FILE` are optional and set the CA bundle.
 *
 * Returns `undefined` when neither pair is set, which callers should treat as
 * "serve plain HTTP/1.1". When a cert is set without a key (or vice versa)
 * this throws — that's a config error worth surfacing.
 */
export function loadTlsCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { cert: Buffer; key: Buffer; ca?: Buffer } | undefined {
  const certInline = env.FUSION_TLS_CERT;
  const keyInline = env.FUSION_TLS_KEY;
  const certFile = env.FUSION_TLS_CERT_FILE;
  const keyFile = env.FUSION_TLS_KEY_FILE;

  const hasCert = Boolean(certInline || certFile);
  const hasKey = Boolean(keyInline || keyFile);
  if (!hasCert && !hasKey) return undefined;
  if (hasCert !== hasKey) {
    throw new Error(
      "FUSION_TLS_* environment is incomplete: set both a cert and a key " +
        "(inline via FUSION_TLS_CERT/FUSION_TLS_KEY or paths via *_FILE).",
    );
  }

  const cert = certInline ? Buffer.from(certInline) : readFileSync(certFile!);
  const key = keyInline ? Buffer.from(keyInline) : readFileSync(keyFile!);

  const caInline = env.FUSION_TLS_CA;
  const caFile = env.FUSION_TLS_CA_FILE;
  const ca = caInline
    ? Buffer.from(caInline)
    : caFile
      ? readFileSync(caFile)
      : undefined;

  return { cert, key, ca };
}

type CliRelaunchSessionStore = ServerOptions["cliSessionTransport"] extends infer T
  ? T extends { store: infer S }
    ? S & {
        updateSession?: (id: string, input: {
          agentState?: "dead";
          terminationReason?: "killed";
          nativeSessionId?: string | null;
          resumeAttempts?: number;
        }) => unknown;
      }
    : never
  : never;

interface CliRelaunchTaskStoreLike {
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, patch: Record<string, unknown>): Promise<unknown>;
  moveTask(taskId: string, column: "todo", options?: Record<string, unknown>): Promise<unknown>;
  logEntry(taskId: string, message: string, details?: string): Promise<unknown>;
}

export function wireCliRelaunchListener(options: {
  relaunch: CliRelaunchRegistry;
  cliSessionStore: CliRelaunchSessionStore;
  engine?: Pick<import("@fusion/engine").ProjectEngine, "getTaskStore" | "getProjectId">;
  runtimeLogger?: RuntimeLogger;
}): (() => void) | undefined {
  if (!options.engine) return undefined;
  const taskStore = options.engine.getTaskStore() as unknown as CliRelaunchTaskStoreLike;
  const engineProjectId = options.engine.getProjectId?.();

  return options.relaunch.on((info) => {
    void (async () => {
      if (engineProjectId && info.projectId !== engineProjectId) return;

      /*
       * FNXC:CliRelaunch 2026-06-14-20:16:
       * The relaunch listener guarantees a fresh launch by clearing resume linkage on the dead CLI session, then re-enters the existing task retry lifecycle via `moveTask(todo)`; it never calls the CLI manager's spawn path directly, so the scheduler/executor remains the single task-run entrypoint.
       */
      options.cliSessionStore.updateSession?.(info.sessionId, {
        agentState: "dead",
        terminationReason: "killed",
        nativeSessionId: null,
        resumeAttempts: 2,
      });

      const task = await taskStore.getTask(info.taskId);
      if (!task) {
        options.runtimeLogger?.warn?.("CLI session relaunch skipped; task not found", info);
        return;
      }

      await taskStore.logEntry(
        info.taskId,
        `CLI session relaunch requested from ${info.sessionId} — clearing resume linkage and re-enqueueing for a fresh executor run`,
      );
      await taskStore.updateTask(info.taskId, { paused: false, status: null, error: null });
      await taskStore.moveTask(info.taskId, "todo", {
        preserveProgress: true,
        moveSource: "engine",
        recoveryRehome: true,
      });
    })().catch((err: unknown) => {
      options.runtimeLogger?.warn?.("CLI session relaunch listener failed", {
        sessionId: info.sessionId,
        taskId: info.taskId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/*
FNXC:GrokCliRouting 2026-07-10-00:00:
Select the PluginRunner the default (no-project) ChatManager uses for runtime
resolution. Grok CLI routing (deriveGrokRuntimeHintForNoVisibleKey → resolveRuntime)
calls `getRuntimeById` and `createRuntimeContext`, which exist only on a real
PluginRunner — a bare PluginLoader (what `options.pluginRunner` is in the CLI
`dashboard` command) lacks them, so a `grok-cli/*` chat with no Fusion-visible
GROK_API_KEY threw "getRuntimeById is not a function" and surfaced the misleading
"requires the bundled Grok CLI runtime" error. Prefer the engine's PluginRunner
(the same runner the project-scoped chat path already uses via
engine.getPluginRunner()); fall back to `options.pluginRunner` only in UI-only
mode where no engine exists.
*/
export function resolveChatManagerPluginRunner(
  options?: Pick<ServerOptions, "engine" | "pluginRunner">,
): ServerOptions["pluginRunner"] {
  const engineRunner = options?.engine?.getPluginRunner?.();
  return (engineRunner as ServerOptions["pluginRunner"] | undefined) ?? options?.pluginRunner;
}

export function createServer(store: TaskStore, options?: ServerOptions): ReturnType<typeof express> {
  // Register the universal post-create hook so every task-creation path
  // (HTTP routes, CLI, pi extension, mission triage, etc.) triggers
  // GitHub tracking issue creation when enabled.
  try {
    registerGithubTrackingHook({ githubToken: options?.githubToken });
  } catch (error) {
    // Some unit tests mock @fusion/core with narrow export surfaces. Keep
    // server bootstrap resilient when hook registration is unavailable.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[github-tracking-hook] registration skipped: ${message}`);
  }
  const cliPackageVersion = getCliPackageVersion(import.meta.url);
  // ── Derive defaults from engine when provided (explicit options override) ──
  const engine = options?.engine;
  if (engine) {
    if (!options!.onMerge) {
      options = { ...options, onMerge: (taskId: string) => engine.onMerge(taskId) };
    }
    if (!options!.automationStore) {
      options = { ...options, automationStore: engine.getAutomationStore() };
    }
    /*
    FNXC:ProviderAuth 2026-07-09-00:00:
    FN-7747 / #1948: derive a fallback authStorage from the engine (mirroring the other
    subsystem derivations here) so a host that wires an `engine` but forgets to pass its own
    `authStorage` still gets a working, persisting credential store instead of
    register-auth-routes.ts's "Authentication is not configured" throw. Explicit
    options.authStorage always overrides. Optional chaining tolerates engine test doubles
    without getAuthStorage().
    */
    if (!options!.authStorage) {
      const as = engine.getAuthStorage?.();
      if (as) options = { ...options, authStorage: as };
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
    if (!options!.selfHealingManager) {
      const selfHealing = engine.getSelfHealingManager();
      if (selfHealing) {
        options = {
          ...options,
          selfHealingManager: {
            rootDir: engine.getWorkingDirectory(),
            reconcileInReviewBranchRebind: selfHealing.reconcileInReviewBranchRebind.bind(selfHealing),
            getActiveMergeTaskId: selfHealing.getActiveMergeTaskId.bind(selfHealing),
          },
        };
      }
    }
    if (!options!.routineStore) {
      const rs = engine.getRoutineStore();
      if (rs) options = { ...options, routineStore: rs };
    }
    if (!options!.routineRunner) {
      const rr = engine.getRoutineRunner();
      if (rr) {
        options = {
          ...options,
          routineRunner: {
            triggerManual: rr.triggerManual.bind(rr),
            triggerWebhook: rr.triggerWebhook.bind(rr),
          },
        };
      }
    }
  }

  // Register callback for lazy engine startup on secondary projects
  if (options?.onProjectFirstAccessed) {
    setOnProjectFirstCreated(options.onProjectFirstAccessed);
  }
  /*
  FNXC:GlobalConcurrencyControls 2026-06-26-17:22:
  Dashboard bootstrap wires CentralCore's live running-agent source to the already-open project-store cache. This avoids duplicating route-local counting while preserving the read-path rule that unopened projects are not initialized just to compute global concurrency counts.

  FNXC:GlobalConcurrencyControls 2026-06-26-23:41:
  The default in-process TaskStore is already open but is intentionally not part of the secondary project-store cache. Include it by central default project id, and include any engine-manager stores already resident in memory, so live reads cover every already-open store without calling getOrCreateProjectStore(), watch(), or runtime startup paths.

  FNXC:GlobalConcurrencyControls 2026-06-28-16:48:
  FN-7205 requires the footer and Command Center counters to reflect actual running top-level agents from the live runtime store. Prefer engine-manager stores over registered/default fallback stores, and only use the default store when no live engine/registered source has supplied that project, so stale bootstrap stores cannot overwrite the semaphore-facing runtime count after a slider or engine lifecycle change.
  */
  setRunningAgentCountSource(async (projectIds) => {
    const requestedProjectIds = new Set(projectIds);
    const counts = await countRunningAgentsInRegisteredProjectStores(projectIds);

    if (options?.engineManager) {
      await Promise.all(projectIds.map(async (projectId) => {
        const engine = options.engineManager?.getEngine(projectId);
        if (!engine) {
          return;
        }
        counts[projectId] = await countRunningAgentsInStore(engine.getTaskStore());
      }));
    }

    const defaultProjectId = await options?.centralCore?.getDefaultProjectId?.();
    if (defaultProjectId && requestedProjectIds.has(defaultProjectId) && counts[defaultProjectId] === undefined) {
      counts[defaultProjectId] = await countRunningAgentsInStore(store);
    }

    return counts;
  });

  const app = express();
  app.locals.hybridExecutor = options?.hybridExecutor;
  const runtimeLogger = options?.runtimeLogger ?? createRuntimeLogger("server");
  const mutationRateLimit = rateLimit(RATE_LIMITS.mutation);
  const setupRateLimit = rateLimit(RATE_LIMITS.api);
  const setupReadRateLimit = rateLimit(RATE_LIMITS.api);
  const sseControlRateLimit = rateLimit({ windowMs: 60_000, max: 300 });

  // Raw body buffer for webhook signature verification - must be before express.json()
  // Only applied to the webhook route
  app.use("/api/github/webhooks", express.raw({ type: "application/json" }));

  // Standard JSON parsing for all other routes.
  // Preserve the raw payload buffer so signed endpoints (for example
  // /api/routines/:id/webhook and settings sync proxying) can verify HMAC
  // signatures and forward exact request bytes.
  app.use(express.json({
    verify: (req, _res, buf) => {
      if (buf.length > 0) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      }
    },
  }));

  // Daemon mode: bearer token authentication middleware
  // Auth is enabled when daemon option is provided OR FUSION_DAEMON_TOKEN env var is set.
  // The middleware exempts /api/health and everything outside /api/ — the SPA shell
  // (index.html + built assets) is public so the browser can load the frontend JS
  // that then captures ?token= from the URL and injects a Bearer header on every
  // /api/* call. WebSocket upgrades are gated separately in setupTerminalWebSocket /
  // setupBadgeWebSocket.
  const daemonToken = options?.noAuth
    ? undefined
    : options?.daemon?.token ?? process.env.FUSION_DAEMON_TOKEN;
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

  let cachedIndexClientDir: string | null = null;
  let cachedIndexHtml: string | null = null;
  let cachedIndexMtimeMs: number | null = null;
  let cachedTemplatedIndexHtml: string | null = null;

  const renderIndexHtml = (): string => {
    const resolvedClientDir = process.env.FUSION_CLIENT_DIR
      ? process.env.FUSION_CLIENT_DIR
      : clientDir;

    const indexPath = join(resolvedClientDir, "index.html");
    // Invalidate the cache when index.html changes on disk (e.g. a release
    // upgrade or rebuild replaces the file). Without this, the server keeps
    // serving stale HTML pointing at chunk hashes that no longer exist —
    // recoverable only by restarting the server.
    let indexMtimeMs: number | null = null;
    try {
      indexMtimeMs = statSync(indexPath).mtimeMs;
    } catch {
      indexMtimeMs = null;
    }

    const dirChanged = cachedIndexClientDir !== resolvedClientDir;
    const mtimeChanged = indexMtimeMs !== null && cachedIndexMtimeMs !== indexMtimeMs;

    if (cachedTemplatedIndexHtml && !dirChanged && !mtimeChanged) {
      return cachedTemplatedIndexHtml;
    }

    if (!cachedIndexHtml || dirChanged || mtimeChanged) {
      cachedIndexHtml = readFileSync(indexPath, "utf8");
      cachedIndexClientDir = resolvedClientDir;
      cachedIndexMtimeMs = indexMtimeMs;
    }

    const chunkMap = loadViewChunkManifest(resolvedClientDir);
    const injection = buildViewPreloadInjection(chunkMap);
    const marker = "<!-- fusion:view-preload -->";
    const withInjectedHead = cachedIndexHtml.includes(marker)
      ? cachedIndexHtml.replace(marker, `${marker}\n${injection}`)
      : cachedIndexHtml.replace("</head>", `${injection}</head>`);

    cachedTemplatedIndexHtml = withInjectedHead;
    return withInjectedHead;
  };

  const serveIndexHtml = (_req: express.Request, res: express.Response): void => {
    try {
      const html = renderIndexHtml();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.status(200).send(html);
    } catch (err) {
      console.error("[dashboard] serveIndexHtml failed:", err);
      // Drop the cached HTML so the next request retries from disk rather
      // than re-throwing the same failure until the server restarts.
      cachedIndexHtml = null;
      cachedTemplatedIndexHtml = null;
      cachedIndexMtimeMs = null;
      res.status(503).type("text/plain").send("Dashboard temporarily unavailable. Retrying...");
    }
  };

  if (!isHeadless) {
    app.get("/version.json", (_req, res) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.sendFile(join(clientDir, "version.json"), (err) => {
        if (err) {
          res.status(404).json({ version: null });
        }
      });
    });
    if (existsSync(join(clientDir, "index.html"))) {
      app.get(["/", "/index.html"], serveIndexHtml);
      app.use(express.static(clientDir, { index: false }));
    }
  }

  // Create ChatStore for chat session management (available for SSE event forwarding)
  // FNXC:RuntimeSatelliteAsync 2026-06-24-21:45:
  // ChatStore dual-path: uses async layer in backend mode, sync DB otherwise.
  const chatLayer = store.getAsyncLayer();
  const chatStore = options?.chatStore ?? new ChatStore(
    store.getFusionDir(),
    chatLayer ? null : store.getDatabase(),
    { asyncLayer: chatLayer },
  );
  store.on("task:moved", (data: { task: Task; from: string; to: string }) => {
    if (data.to !== "archived") return;
    /*
    FNXC:TaskDetailPlannerChatRetention 2026-06-30-18:45:
    Task-detail planner chats are retained after done when a user interacted, but task archival is the retention cutoff. Delete exact task-planner sessions on archive so normal chats and other tasks' planner chats remain intact while chat:session:deleted events clear dashboard caches.
    */
    void chatStore.deleteSessionsForAgentId(`${TASK_PLANNER_CHAT_AGENT_ID_PREFIX}${data.task.id}`);
  });
  options?.engine?.attachChatStore?.(chatStore);
  if (typeof options?.engineManager?.getAllEngines === "function") {
    for (const engine of options.engineManager.getAllEngines().values()) {
      engine.attachChatStore?.(chatStore);
    }
  }

  // Lets the browser explicitly release server-side SSE listeners during page
  // unload. EventSource.close() is not enough in Chrome refresh paths because
  // the HTTP/1.1 transport can remain open in the browser network service.
  app.post("/api/events/disconnect", sseControlRateLimit, (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    disconnectSSEClient(clientId, projectId);
    res.status(204).end();
  });

  app.post("/api/events/keepalive", sseControlRateLimit, (req, res) => {
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    markSSEClientAlive(clientId, projectId);
    res.status(204).end();
  });

  // Rate limiting — stricter limit on SSE connections
  app.get("/api/events", rateLimit(RATE_LIMITS.sse), async (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const engineManager = options?.engineManager;

    // FNXC:MissionStore 2026-06-28-13:10:
    // Both MissionStore and the PG-backend AsyncMissionStore now extend EventEmitter and
    // emit the same mission/milestone/slice/feature events, so SSE subscribes to whichever
    // getMissionStore() resolves — live mission refresh works in both backends. (Previously
    // this instanceof-narrowed to the sync store and passed undefined in PG mode, leaving
    // mission SSE degraded.) createSSE still handles undefined for a missing store.
    const safeGetMissionStore = (
      s: TaskStore,
    ): ReturnType<TaskStore["getMissionStore"]> | undefined => {
      try {
        return s.getMissionStore();
      } catch {
        return undefined;
      }
    };

    if (!projectId) {
      // Create AgentStore for default project SSE
      const { AgentStore: AgentStoreClass } = await import("@fusion/core");
      const defaultAgentStore = new AgentStoreClass({ rootDir: store.getFusionDir() });
      await defaultAgentStore.init();
      const defaultMessageStore = options?.engine?.getMessageStore();
      createSSE(
        store,
        safeGetMissionStore(store),
        aiSessionStore!,
        store.getPluginStore(),
        undefined,
        defaultAgentStore,
        defaultMessageStore,
        chatStore,
        options?.automationStore,
      )(req, res);
      return;
    }

    try {
      // Prefer the engine's store when available — this ensures SSE listeners
      // attach to the same EventEmitter instance that the engine writes to,
      // rather than a separate store created by getOrCreateProjectStore.
      let scopedStore: TaskStore;
      let agentStore: AgentStore | undefined;
      let messageStore: MessageStore | undefined;
      let automationStore: AutomationStore | undefined;
      let scopedChatStore = chatStore;
      if (engineManager) {
        const engine = engineManager.getEngine(projectId);
        scopedStore = engine?.getTaskStore() ?? await getOrCreateProjectStore(projectId);
        scopedChatStore = getOrCreateScopedChatStore(scopedStore, engine?.getChatStore?.());
        // Use the engine's stores if available
        agentStore = engine?.getAgentStore();
        messageStore = engine?.getMessageStore();
        automationStore = engine?.getAutomationStore();
      } else {
        scopedStore = await getOrCreateProjectStore(projectId);
        scopedChatStore = getOrCreateScopedChatStore(scopedStore);
      }
      // Fallback: create AgentStore if engine doesn't have one
      if (!agentStore) {
        const { AgentStore: AgentStoreClass } = await import("@fusion/core");
        agentStore = new AgentStoreClass({ rootDir: scopedStore.getFusionDir() });
        await agentStore.init();
      }
      if (!automationStore) {
        automationStore = options?.automationStore;
      }
      createSSE(
        scopedStore,
        safeGetMissionStore(scopedStore),
        aiSessionStore!,
        scopedStore.getPluginStore(),
        {
          projectId,
        },
        agentStore,
        messageStore,
        scopedChatStore,
        automationStore,
      )(req, res);
    } catch (err: unknown) {
      sendErrorResponse(res, 500, err instanceof Error ? err.message : "Failed to open project event stream");
    }
  });

  /**
   * Shared project-resolution helper for realtime endpoints.
   * Uses module-level resolveScopedStore with current closure context.
   */
  async function resolveProjectScopedStore(projectId: string | undefined): Promise<TaskStore> {
    // FNXC:CentralProjectIdentity 2026-07-13-23:53:
    // Thread the daemon's registered launch project id so a realtime request
    // without projectId resolves the explicit launch project (registry-bound
    // injected store) rather than the implicit raw-store fallback.
    return resolveScopedStore(projectId, store, options?.engineManager, options?.engine?.getProjectId?.(), options);
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
    // Tool-oriented detail payloads may already be clipped in storage to keep
    // live log streaming responsive. The 500-entry cap is applied client-side
    // in the React hooks (useAgentLogs / useMultiAgentLogs).
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

  // Per-run SSE endpoint for live agent log streaming.
  // Mirrors the per-task endpoint above but subscribes to AgentStore's
  // "run:log" event (emitted from AgentStore.appendRunLog) and filters by
  // agentId + runId.  We need the engine's AgentStore instance specifically,
  // since that's the EventEmitter the heartbeat runtime writes to — a fresh
  // store created here would never receive events.
  app.get("/api/agents/:id/runs/:runId/logs/stream", async (req, res) => {
    const agentId = req.params.id;
    const runId = req.params.runId;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");

    const engineManager = options?.engineManager;
    const engine = engineManager && projectId ? engineManager.getEngine(projectId) : options?.engine;
    const agentStore = engine?.getAgentStore();

    if (!agentStore) {
      // No live engine — there is no event source to subscribe to. Close
      // gracefully so the client falls back to its initial fetch.
      res.write(`event: error\ndata: ${JSON.stringify({ message: "No active engine for project" })}\n\n`);
      res.end();
      return;
    }

    const onRunLog = (eventAgentId: string, eventRunId: string, entry: AgentLogEntry) => {
      if (eventAgentId !== agentId || eventRunId !== runId) return;
      res.write(`event: agent:log\ndata: ${JSON.stringify(entry)}\n\n`);
    };

    agentStore.on("run:log", onRunLog);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      agentStore.off("run:log", onRunLog);
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
    const planningLogger = runtimeLogger.child("planning");
    app.use("/api/planning", (req, _res, next) => {
      planningLogger.info("request", {
        method: req.method,
        path: req.path,
        originalUrl: req.originalUrl,
        contentType: req.headers["content-type"],
      });
      next();
    });
  }

  // Create AiSessionStore for background task persistence
  // FNXC:RuntimeSatelliteCompletion 2026-06-25-00:05:
  // AiSessionStore dual-path: uses async layer in backend mode, sync DB otherwise.
  const aiSessionLayer = store.getAsyncLayer();
  const aiSessionStore: AiSessionStore | undefined = options?.aiSessionStore ?? new AiSessionStore(
    aiSessionLayer ? null as unknown as import("@fusion/core").Database : store.getDatabase(),
    { asyncLayer: aiSessionLayer },
  );
  if (aiSessionStore) {
    // FNXC:RuntimeSatelliteCompletion 2026-06-25-00:20:
    // recoverStaleSessions + rehydrateFromStore are now async. Fire-and-forget
    // at startup since the server must return the Express app synchronously.
    // The recovery completes before the first request in practice (event loop
    // drains microtasks before I/O), and is best-effort regardless.
    void aiSessionStore.recoverStaleSessions();
    setPlanningAiSessionStore(aiSessionStore);
    setSubtaskAiSessionStore(aiSessionStore);
    setMissionAiSessionStore(aiSessionStore);
    setMilestoneSliceAiSessionStore(aiSessionStore);
  }

  // Fire-and-forget rehydration; store references for logging.
  let planningRehydratedCount = 0;
  let subtaskRehydratedCount = 0;
  let missionRehydratedCount = 0;
  let milestoneSliceRehydratedCount = 0;
  if (aiSessionStore) {
    void rehydratePlanningSessions(aiSessionStore).then((c) => { planningRehydratedCount = c; });
    void rehydrateSubtaskSessions(aiSessionStore).then((c) => { subtaskRehydratedCount = c; });
    void rehydrateMissionSessions(aiSessionStore).then((c) => { missionRehydratedCount = c; });
    void rehydrateMilestoneSliceSessions(aiSessionStore).then((c) => { milestoneSliceRehydratedCount = c; });
  }
  // FNXC:RuntimeSatelliteCompletion 2026-06-25-00:25:
  // Rehydration counts are logged asynchronously after the fire-and-forget
  // promises resolve. The synchronous total is 0 since the promises haven't
  // settled yet. This is intentional: the server must return the Express app
  // synchronously, and rehydration is best-effort.
  const totalRehydrated = 0;
  if (totalRehydrated > 0) {
    runtimeLogger.info("AI session rehydrate summary", {
      message: "Rehydrated AI sessions from SQLite",
      planningRehydratedCount,
      subtaskRehydratedCount,
      missionRehydratedCount,
      milestoneSliceRehydratedCount,
      totalRehydrated,
    });
  }

  // Create AgentStore for chat prompt enrichment (initialized lazily by ChatManager)
  // FNXC:SqliteFinalRemoval 2026-06-26-11:00:
  // In backend mode, pass the AsyncDataLayer so AgentStore delegates to the
  // async helpers; otherwise use the legacy SQLite path.
  const chatAgentLayer = store.getAsyncLayer();
  const chatAgentStore = new AgentStore({
    rootDir: store.getFusionDir(),
    ...(chatAgentLayer ? { asyncLayer: chatAgentLayer } : {}),
  });

  // Create ChatManager for AI chat message handling.
  /*
  FNXC:GrokCliRouting 2026-07-10-00:00:
  The default (no-project) ChatManager must receive a real PluginRunner — not the
  bare PluginLoader passed as `options.pluginRunner`. Grok CLI routing
  (deriveGrokRuntimeHintForNoVisibleKey → resolveRuntime) calls `getRuntimeById`
  and `createRuntimeContext`, which exist only on PluginRunner; a PluginLoader
  lacks them, so a `grok-cli/*` chat with no visible GROK_API_KEY threw
  "getRuntimeById is not a function" → the misleading "requires the bundled Grok
  CLI runtime" error. Prefer the engine's PluginRunner (the same runner the
  project-scoped chat path already uses via engine.getPluginRunner()), falling
  back to the loader only in UI-only mode where no engine exists.
  */
  const chatManager = options?.chatManager ?? new ChatManager(
    chatStore!,
    store.getRootDir(),
    chatAgentStore,
    resolveChatManagerPluginRunner(options),
    () => store.getSettings(),
    options?.engine?.getMessageStore(),
    store,
  );

  // CLI Agent Executor — chat surface wiring. When the cli-session transport is
  // supplied (the runtime is live), broker cli-backed chat sends to the PTY and
  // route the project hub's sanitized telemetry into the runner's transcript
  // handler. The listener is keyed per-session inside one closure so it composes
  // safely even if other taps exist.
  if (options?.cliSessionTransport && options.engine) {
    try {
      wireCliRelaunchListener({
        relaunch: options.cliSessionTransport.relaunch,
        cliSessionStore: options.cliSessionTransport.store as CliRelaunchSessionStore,
        engine: options.engine,
        runtimeLogger,
      });
    } catch (err) {
      runtimeLogger.warn?.("CLI-agent relaunch listener wiring failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (options?.cliSessionTransport && options.cliAgentHubResolver && chatStore) {
    try {
      const cliTransportStore = options.cliSessionTransport.store;
      // The transport's `manager` is typed for the attach/inject transport slice;
      // the chat runner additionally needs `spawn`. The concrete engine
      // CliSessionManager provides both — widen via a structural cast to the
      // spawn/inject slice the runner consumes.
      const spawnInject = options.cliSessionTransport.manager as unknown as {
        spawn: (opts: {
          adapterId: string;
          projectId: string;
          purpose: "chat";
          chatSessionId: string;
          worktreePath?: string | null;
          resume?: { sessionId: string; nativeSessionId: string };
        }) => Promise<{ id: string; nativeSessionId: string | null; agentState: string }>;
        inject: (sessionId: string, text: string) => Promise<void>;
      };
      // The runner needs spawn/inject (manager) + a fresh session record getter
      // (store). Compose the slice the runner expects so flush decisions read
      // authoritative records.
      const cliChatRunner = new CliChatSessionRunner({
        store: chatStore,
        manager: {
          spawn: (opts) => spawnInject.spawn(opts),
          inject: (sessionId, text) => spawnInject.inject(sessionId, text),
          getSession: (sessionId) => {
            const r = cliTransportStore.getSession(sessionId);
            return r
              ? { id: r.id, nativeSessionId: r.nativeSessionId, agentState: r.agentState }
              : undefined;
          },
        },
      });
      chatManager.setCliChatRunner(cliChatRunner, options.engine?.getProjectId?.());
      const hub = options.cliAgentHubResolver(undefined, "");
      if (hub) {
        hub.setEventListener((cliSessionId, event) => {
          // Per-session routing inside one listener: map the CLI session id to its
          // owning chat session (only chat-purpose sessions carry chatSessionId);
          // non-chat sessions (task/validator) are ignored here.
          const record = cliTransportStore.getSession(cliSessionId);
          const chatSessionId = record?.chatSessionId;
          if (!chatSessionId) return;
          void cliChatRunner
            .handleTelemetry(chatSessionId, {
              kind: event.kind,
              text: event.text,
              nativeSessionId: event.nativeSessionId,
            })
            .catch(() => {
              // best-effort: a transcript-handler throw must never break ingest.
            });
        });
      }
    } catch (err) {
      runtimeLogger.warn?.("CLI-agent chat runner wiring failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const runAiSessionCleanup = async (maxAgeMs: number, source: "initial" | "scheduled") => {
    if (!aiSessionStore) return { terminalDeleted: 0, orphanedDeleted: 0 };
    const result = await aiSessionStore.cleanupStaleSessions(maxAgeMs);
    runtimeLogger.info("AI session cleanup summary", {
      message: "Removed stale AI sessions",
      source,
      ttlMs: maxAgeMs,
      terminalDeleted: result.terminalDeleted,
      orphanedDeleted: result.orphanedDeleted,
      totalDeleted: result.totalDeleted,
    });
    return result;
  };

  const scheduleAiSessionCleanup = (cleanupIntervalMs: number, maxAgeMs: number) => {
    clearAiSessionCleanupInterval();
    aiSessionCleanupIntervalHandle = setInterval(() => {
      runAiSessionCleanup(maxAgeMs, "scheduled").catch((err) => {
        runtimeLogger.error("AI session cleanup failed", {
          message: "Scheduled AI session cleanup failed",
          source: "scheduled",
          ttlMs: maxAgeMs,
          cleanupIntervalMs,
          ...normalizeErrorForLog(err),
        });
      });
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
              runtimeLogger.error("AI session cleanup failed", {
                message: "Initial AI session cleanup failed",
                source: "initial",
                ttlMs,
                ...normalizeErrorForLog(err),
              });
            });

          scheduleAiSessionCleanup(cleanupIntervalMs, ttlMs);
        })
        .catch((err) => {
          runtimeLogger.warn("AI session cleanup settings fallback", {
            message: "Failed to load settings for AI session cleanup; using defaults",
            fallbackTtlMs: DEFAULT_AI_SESSION_TTL_MS,
            fallbackCleanupIntervalMs: DEFAULT_AI_SESSION_CLEANUP_INTERVAL_MS,
            ...normalizeErrorForLog(err),
          });

          void Promise.resolve()
            .then(() => runAiSessionCleanup(DEFAULT_AI_SESSION_TTL_MS, "initial"))
            .catch((cleanupErr) => {
              runtimeLogger.error("AI session cleanup failed", {
                message: "Initial AI session cleanup failed",
                source: "initial",
                ttlMs: DEFAULT_AI_SESSION_TTL_MS,
                ...normalizeErrorForLog(cleanupErr),
              });
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
          runtimeLogger.error("AI session cleanup failed", {
            message: "Initial AI session cleanup failed",
            source: "initial",
            ttlMs: DEFAULT_AI_SESSION_TTL_MS,
            ...normalizeErrorForLog(err),
          });
        });

      scheduleAiSessionCleanup(
        DEFAULT_AI_SESSION_CLEANUP_INTERVAL_MS,
        DEFAULT_AI_SESSION_TTL_MS,
      );
    }
  }

  /*
   * FNXC:PostgresHealth 2026-06-24-16:10:
   * The /api/health endpoint is async because PostgreSQL health checks
   * (connectivity probe, task-ID integrity via Drizzle) are inherently async.
   * When postgresHealthLayer is provided, the endpoint uses PostgreSQL-native
   * checks; otherwise it falls back to the legacy SQLite health checks.
   * VAL-HEALTH-001: healthy backend reports green; VAL-HEALTH-002: corrupt/
   * unreachable backend surfaces degraded status + errors.
   */
  app.get("/api/health", async (_req, res) => {
    const pgLayer = options?.postgresHealthLayer;
    if (pgLayer) {
      const { checkPostgresHealth } = await import("@fusion/core");
      const { detectTaskIdIntegrityAnomaliesAsync } = await import("@fusion/core");
      const errors = await checkPostgresHealth(pgLayer).catch((err: unknown) => [
        `PostgreSQL health check failed: ${err instanceof Error ? err.message : String(err)}`,
      ]);
      const integrityReport = await detectTaskIdIntegrityAnomaliesAsync(pgLayer.db).catch(() => ({
        status: "ok" as const,
        checkedAt: new Date().toISOString(),
        anomalies: [],
      }));
      res.json(buildHealthPayload({
        database: {
          healthy: errors.length === 0,
          corruptionDetected: errors.length > 0,
          corruptionErrors: errors.slice(0, 5),
          lastCheckedAt: new Date(),
          isRunning: false,
        },
        taskIdIntegrityReport: integrityReport,
        cliPackageVersion,
        engineAvailable: hasDashboardEngine(options),
      }));
      return;
    }
    res.json(buildHealthPayload({
      database: store.getDatabaseHealth(),
      taskIdIntegrityReport: store.getTaskIdIntegrityReport(),
      cliPackageVersion,
      engineAvailable: hasDashboardEngine(options),
    }));
  });

  app.get("/api/engine/status", (req, res) => {
    const projectId = getProjectIdFromRequest(req);
    res.json(buildEngineStatusPayload(projectId, options));
  });

  app.post("/api/engine/start", async (req, res) => {
    const projectId = getProjectIdFromRequest(req);
    const engineManager = options?.engineManager;

    if (!engineManager) {
      res.status(409).json({ error: "Engine manager is unavailable", reason: "dashboard-only" });
      return;
    }

    if (!projectId) {
      res.status(409).json({ error: "Project id is required", reason: "no-project" });
      return;
    }

    try {
      /*
       * FNXC:EngineStatusBanner 2026-06-22-00:00:
       * The one-click Start engine action must also recover intentionally paused projects. `ensureEngine` refuses paused projects by design, so the route checks CentralCore first and uses `resumeProject` for paused status while keeping active projects on the normal `ensureEngine` path.
       */
      const project = await options?.centralCore?.getProject(projectId);
      if (project && (project.status as string) === "paused") {
        await engineManager.resumeProject(projectId);
      } else {
        await engineManager.ensureEngine(projectId);
      }
      res.json(buildEngineStatusPayload(projectId, options));
    } catch (error) {
      const message = getErrorMessage(error);
      const isPausedGuard = message === `Project ${projectId} is paused`;
      res.status(isPausedGuard ? 409 : 500).json({ error: message, reason: isPausedGuard ? "paused" : undefined });
    }
  });

  app.get("/api/health/reliability", async (req, res) => {
    const projectId = getProjectIdFromRequest(req);
    /*
    FNXC:ReliabilityHealth 2026-07-10-11:15:
    Reliability GET/reset must read/write the per-project store so multi-project servers report per-project stats.
    Use the in-scope resolveProjectScopedStore helper (createServer scope) — NOT the badge-websocket getScopedStore, which lives in a different function and is not visible here.
    Store creation can fail (getOrCreateProjectStore throwing on a DB error); mirror the project SSE handler and return a targeted 500 instead of letting the failure fall through to the generic Express error handler with a vague message.
    */
    let scopedStore: TaskStore;
    try {
      scopedStore = await resolveProjectScopedStore(projectId);
    } catch (err: unknown) {
      sendErrorResponse(res, 500, err instanceof Error ? err.message : "Failed to resolve project store");
      return;
    }
    const rawWindowDays = req.query.windowDays;
    const parsedWindowDays = rawWindowDays === undefined ? 7 : Number.parseInt(String(rawWindowDays), 10);

    if (!Number.isInteger(parsedWindowDays) || parsedWindowDays < 1 || parsedWindowDays > 30) {
      res.status(400).json({
        error: "Invalid windowDays",
        message: "windowDays must be an integer between 1 and 30",
      });
      return;
    }

    const settings = await scopedStore.getSettings();
    const resetAt = typeof settings.reliabilityStatsResetAt === "string" ? settings.reliabilityStatsResetAt : null;

    const nowMs = Date.now();
    const windowStartMs = nowMs - parsedWindowDays * 86_400_000;
    const resetAtMs = resetAt ? Date.parse(resetAt) : Number.NaN;
    const effectiveStartMs = Number.isFinite(resetAtMs) ? Math.max(windowStartMs, resetAtMs) : windowStartMs;
    const startIso = new Date(effectiveStartMs).toISOString();
    const endIso = new Date(nowMs).toISOString();

    const [runAuditEvents, enteredByDay, bouncedByDay, durationEvents, mergedTaskIds] = await Promise.all([
      Promise.resolve(scopedStore.getRunAuditEvents({ startTime: startIso, endTime: endIso, limit: 50_000 })),
      scopedStore.getTaskMovedCountsByDay({ since: startIso, until: endIso, toColumn: "in-review" }),
      scopedStore.getTaskMovedCountsByDay({ since: startIso, until: endIso, fromColumn: "in-review", toColumn: "in-progress" }),
      scopedStore.getInReviewDurationEvents({ since: startIso, until: endIso }),
      scopedStore.getTaskMergedTaskIds({ since: startIso, until: endIso }),
    ]);

    const postMergeByDay = postMergeAuditFailuresPerDay(runAuditEvents, effectiveStartMs, nowMs);
    const fileScopeByDay = fileScopeInvariantFailuresPerDay(runAuditEvents, effectiveStartMs, nowMs);
    const recoveriesByDay = recoverAlreadyMergedReviewTasksRecoveriesPerDay(runAuditEvents, effectiveStartMs, nowMs);
    const duration = inReviewDurationMetrics(durationEvents, effectiveStartMs, nowMs);
    const mergeAttempts = mergeAttemptsPerMergedTask(runAuditEvents, mergedTaskIds, effectiveStartMs, nowMs);
    const headline = inReviewFailureRate7d(enteredByDay, bouncedByDay, nowMs);

    const perDay: Array<{
      date: string;
      tasksEnteredInReview: number;
      tasksBouncedToInProgress: number;
      postMergeAuditFailures: { block: number; warn: number; off: number } | null;
      fileScopeInvariantFailures: number | null;
      recoverAlreadyMergedReviewTasksRecoveries: number | null;
      hasSamples: boolean;
    }> = [];

    const dayCursor = new Date(effectiveStartMs);
    const dayEnd = new Date(endIso);
    dayCursor.setUTCHours(0, 0, 0, 0);
    dayEnd.setUTCHours(0, 0, 0, 0);

    while (dayCursor.getTime() <= dayEnd.getTime()) {
      const day = dayCursor.toISOString().slice(0, 10);
      const tasksEnteredInReview = enteredByDay[day] ?? 0;
      const tasksBouncedToInProgress = bouncedByDay[day] ?? 0;
      const postMergeAuditFailures = postMergeByDay.value ? (postMergeByDay.value[day] ?? { block: 0, warn: 0, off: 0 }) : null;
      const fileScopeInvariantFailures = fileScopeByDay.value ? (fileScopeByDay.value[day] ?? 0) : null;
      const recoverAlreadyMergedReviewTasksRecoveries = recoveriesByDay.value ? (recoveriesByDay.value[day] ?? 0) : null;
      const hasSamples = dayHasSamples({
        tasksEnteredInReview,
        tasksBouncedToInProgress,
        postMergeAuditFailures,
        fileScopeInvariantFailures,
        recoverAlreadyMergedReviewTasksRecoveries,
      });

      perDay.push({
        date: day,
        tasksEnteredInReview,
        tasksBouncedToInProgress,
        postMergeAuditFailures,
        fileScopeInvariantFailures,
        recoverAlreadyMergedReviewTasksRecoveries,
        hasSamples,
      });
      dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
    }

    res.json({
      windowDays: parsedWindowDays,
      generatedAt: new Date(nowMs).toISOString(),
      resetAt,
      headline: {
        inReviewFailureRate7d: headline.value,
        ...(headline.reason ? { reason: headline.reason } : {}),
      },
      perDay,
      perDayNonEmpty: perDay.filter((row) => row.hasSamples),
      duration: {
        p50Ms: duration.p50Ms,
        p95Ms: duration.p95Ms,
        sampleCount: duration.sampleCount,
        ...(duration.reason ? { reason: duration.reason } : {}),
      },
      mergeAttempts: {
        mean: mergeAttempts.mean,
        max: mergeAttempts.max,
        histogram: mergeAttempts.histogram,
        ...(mergeAttempts.reason ? { reason: mergeAttempts.reason } : {}),
      },
    });
  });

  app.post("/api/health/reliability/reset", async (req, res) => {
    const projectId = getProjectIdFromRequest(req);
    /*
    FNXC:ReliabilityHealth 2026-07-10-11:15:
    Same in-scope resolveProjectScopedStore + guard as the GET handler so the reset writes reliabilityStatsResetAt to the per-project store and a store-creation failure returns a targeted 500 rather than a vague generic error.
    */
    let scopedStore: TaskStore;
    try {
      scopedStore = await resolveProjectScopedStore(projectId);
    } catch (err: unknown) {
      sendErrorResponse(res, 500, err instanceof Error ? err.message : "Failed to resolve project store");
      return;
    }
    const resetAt = new Date().toISOString();
    await scopedStore.updateSettings({ reliabilityStatsResetAt: resetAt });
    res.json({ resetAt });
  });

  app.post("/api/health/refresh", async (_req, res) => {
    /*
     * FNXC:PostgresHealth 2026-06-24-16:15:
     * Force-recompute integrity + database health. When postgresHealthLayer
     * is provided, uses PostgreSQL-native checks (VAL-HEALTH-002: clears stale
     * corruption banner after repair). Otherwise falls back to the legacy
     * SQLite refresh path.
     */
    const pgLayer = options?.postgresHealthLayer;
    if (pgLayer) {
      const { checkPostgresHealth } = await import("@fusion/core");
      const { detectTaskIdIntegrityAnomaliesAsync } = await import("@fusion/core");
      const errors = await checkPostgresHealth(pgLayer).catch((err: unknown) => [
        `PostgreSQL health check failed: ${err instanceof Error ? err.message : String(err)}`,
      ]);
      const integrityReport = await detectTaskIdIntegrityAnomaliesAsync(pgLayer.db).catch(() => ({
        status: "ok" as const,
        checkedAt: new Date().toISOString(),
        anomalies: [],
      }));
      res.json(buildHealthPayload({
        database: {
          healthy: errors.length === 0,
          corruptionDetected: errors.length > 0,
          corruptionErrors: errors.slice(0, 5),
          lastCheckedAt: new Date(),
          isRunning: false,
        },
        taskIdIntegrityReport: integrityReport,
        cliPackageVersion,
        engineAvailable: hasDashboardEngine(options),
      }));
      return;
    }
    res.json(buildHealthPayload({
      database: store.refreshDatabaseHealth(),
      taskIdIntegrityReport: store.refreshTaskIdIntegrityReport(),
      cliPackageVersion,
      engineAvailable: hasDashboardEngine(options),
    }));
  });

  /*
   * FNXC:PostgresHealth 2026-06-24-16:20:
   * Explicit compaction command: runs VACUUM/ANALYZE on the project-schema
   * tables and reports per-table stats (VAL-HEALTH-005). Only available when
   * the PostgreSQL health layer is provided; returns 501 otherwise.
   */
  app.post("/api/health/compact", async (_req, res) => {
    const pgLayer = options?.postgresHealthLayer;
    if (!pgLayer) {
      res.status(501).json({ error: "PostgreSQL compaction is not available (no postgresHealthLayer configured)." });
      return;
    }
    try {
      const { vacuumAnalyze } = await import("@fusion/core");
      const result = await vacuumAnalyze(pgLayer.db);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: `VACUUM/ANALYZE failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  app.get("/api/updates/check", async (_req, res) => {
    const currentVersion = cliPackageVersion;
    res.set("Cache-Control", "no-store");

    if (isUnresolvedCliPackageVersion(currentVersion)) {
      res.status(200).json({
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        error: "Current Fusion version is unavailable",
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch("https://registry.npmjs.org/@runfusion/fusion/latest", {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`registry request failed: ${response.status}`);
      }

      const payload = (await response.json()) as { version?: unknown };
      if (typeof payload.version !== "string" || payload.version.trim().length === 0) {
        throw new Error("registry response missing version");
      }

      const latestVersion = payload.version;
      res.json({
        currentVersion,
        latestVersion,
        updateAvailable: isRemoteVersionNewer(latestVersion, currentVersion),
      });
    } catch {
      res.status(200).json({
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        error: "Failed to check for updates",
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/remote-login", async (req, res) => {
    const remoteToken = typeof req.query.rt === "string" ? req.query.rt : undefined;

    let settings: Awaited<ReturnType<typeof store.getSettings>>;
    try {
      settings = await store.getSettings();
    } catch {
      res.status(401).json({ error: "Unauthorized", code: "remote_token_invalid" });
      return;
    }

    const remoteAccess = settings.remoteAccess;
    if (!remoteAccess) {
      res.status(401).json({ error: "Unauthorized", code: "remote_token_invalid" });
      return;
    }

    const result = validateRemoteAuthToken(remoteToken, remoteAccess);
    if (result.status !== "valid") {
      const codeByStatus: Record<string, string> = {
        missing: "remote_token_missing",
        expired: "remote_token_expired",
        invalid: "remote_token_invalid",
        disabled: "remote_token_invalid",
      };

      res.status(401).json({
        error: "Unauthorized",
        code: codeByStatus[result.status] ?? "remote_token_invalid",
      });
      return;
    }

    const daemonTokenForRedirect = getDaemonToken(options);
    if (daemonTokenForRedirect) {
      const redirectUrl = new URL("/", `${req.protocol}://${req.get("host")}`);
      redirectUrl.searchParams.set("token", daemonTokenForRedirect);
      res.redirect(302, redirectUrl.pathname + redirectUrl.search);
      return;
    }

    res.redirect(302, "/");
  });

  // REST API
  const apiRouter = createApiRoutes(store, {
    ...options,
    runtimeLogger,
    aiSessionStore: aiSessionStore as AiSessionStore,
    chatStore,
    chatManager,
    skillsAdapter: options?.skillsAdapter,
  });
  app.use("/api", apiRouter);

  // CLI agent session REST routes (U10). Daemon-token gated by the app-level
  // auth middleware. Mounted only when transport deps are supplied.
  if (options?.cliSessionTransport) {
    app.use(
      "/api/cli-sessions",
      createCliSessionsRouter({
        manager: options.cliSessionTransport.manager,
        store: options.cliSessionTransport.store,
        ticketStore: options.cliSessionTransport.ticketStore,
        attributionLog: options.cliSessionTransport.attributionLog,
        confirmAdvance: options.cliSessionTransport.confirmAdvance,
        relaunch: options.cliSessionTransport.relaunch,
      }),
    );
  }

  // API 404 Handler - Return JSON for unmatched API routes (instead of falling through to SPA)
  app.use("/api", (_req: express.Request, res: express.Response) => {
    sendErrorResponse(res, 404, "Not found");
  });

  // API Error Handling Middleware - MUST be after API routes but before SPA fallback
  // This ensures API errors return JSON instead of falling through to the SPA fallback (which returns HTML)
   
  /*
  FNXC:ApiErrorDiagnostics 2026-07-10-14:00:
  The /api error boundary is the chokepoint for every unhandled per-request error.
  It must LOG the underlying error (stack + cause), not just echo a message, so a
  500 is root-causable server-side — the reported "task write API returns 500 for
  every task" was undiagnosable because the wrapped error's origin was never
  recorded. The client-facing body stays generic in production (avoid leaking
  internals); pass `error: err` so sendErrorResponse logs the stack/cause.
  */
  app.use("/api", (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) {
      return;
    }

    if (err instanceof ApiError) {
      sendErrorResponse(res, err.statusCode, err.message, { details: err.details, error: err });
      return;
    }

    const fallbackMessage = "Internal server error";
    const message =
      process.env.NODE_ENV === "production"
        ? fallbackMessage
        : err instanceof Error && err.message
          ? err.message
          : fallbackMessage;

    sendErrorResponse(res, 500, message, { error: err });
  });

  if (!isHeadless) {
    app.get("/tasks/:id", (req, res, next) => {
      const taskId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!taskId || !/^[A-Z]+-\d+$/.test(taskId)) {
        next();
        return;
      }

      const params = new URLSearchParams();
      params.set("task", taskId);
      const project = typeof req.query.project === "string" ? req.query.project : undefined;
      if (project) {
        params.set("project", project);
      }

      res.redirect(301, `/?${params.toString()}`);
    });

    // SPA fallback. Only serve index.html for navigation requests — never for
    // hashed asset URLs (/assets/*, /icons/*, /fonts/*) or any path that looks
    // like a static file. Returning index.html for a missing JS chunk poisons
    // the page with a text/html module script (strict MIME failure → blank
    // shell on reload). A real 404 lets versionCheck detect the stale chunk
    // and recover.
    const STATIC_PREFIXES = ["/assets/", "/icons/", "/fonts/", "/brands/"];
    app.get("/{*splat}", (req, res) => {
      const path = req.path;
      if (STATIC_PREFIXES.some((p) => path.startsWith(p)) || /\.[a-z0-9]+$/i.test(path)) {
        res.status(404).end();
        return;
      }
      serveIndexHtml(req, res);
    });
  }

  const dashboardApp = app as DashboardExpressApp;
  dashboardApp.terminalWsServer = null;
  dashboardApp.badgeWsServer = null;
  dashboardApp.badgeWsManager = null;
  dashboardApp.__fnWebSocketsAttached = false;

  const originalListen = dashboardApp.listen.bind(dashboardApp);
  const httpsCreds = options?.https;
  /*
  FNXC:Telemetry 2026-06-16-09:47:
  U10 (PR #1683): the OTLP metrics exporter is started on listen only when FUSION_OTEL_METRICS_ENDPOINT is set (off by default) and its handle is retained here so the server "close" handler can stop the export timer — otherwise the periodic exporter would outlive the server and leak a timer in tests/restarts.
  */
  // U10: OTLP metrics exporter. Disabled by default — only started when
  // FUSION_OTEL_METRICS_ENDPOINT is explicitly configured. Held here so the
  // server "close" handler can stop its timer.
  let otelExporter: OtelExporterHandle | null = null;
  dashboardApp.listen = ((...args: Parameters<typeof dashboardApp.listen>) => {
    const normalizedArgs = normalizeListenArgsForTests(args) as Parameters<typeof originalListen>;

    let server: HttpServer | Http2SecureServer;
    if (httpsCreds) {
      // HTTP/2 with HTTP/1.1 fallback. allowHTTP1 is required so that:
      //   1. WebSocket upgrades (HTTP/1.1-only) keep working.
      //   2. Older clients and curl continue to connect.
      // Express 5's request pipeline is compatible with both h1 and h2 req/res.
      const h2 = createHttp2SecureServer(
        {
          cert: httpsCreds.cert,
          key: httpsCreds.key,
          ca: httpsCreds.ca,
          allowHTTP1: true,
        },
        dashboardApp as unknown as Parameters<typeof createHttp2SecureServer>[1],
      );
      server = h2;
      h2.listen(...(normalizedArgs as Parameters<Http2SecureServer["listen"]>));
    } else {
      server = originalListen(...normalizedArgs);
    }

    // U10: start the OTLP exporter (no-op unless FUSION_OTEL_METRICS_ENDPOINT
    // is set). Failures here must never break server startup.
    try {
      otelExporter = maybeStartOtelExporter({ store, logger: runtimeLogger });
    } catch (error) {
      runtimeLogger.warn("OTLP metrics exporter failed to start", {
        message: "OTLP metrics exporter failed to start",
        ...normalizeErrorForLog(error),
      });
    }

    server.once("close", () => {
      clearAiSessionCleanupInterval();
      aiSessionStore?.stopScheduledCleanup();
      otelExporter?.stop();
      otelExporter = null;
      (apiRouter as Router & { dispose?: () => void }).dispose?.();
      void stopAllDevServers().catch((error) => {
        runtimeLogger.warn("Failed to shutdown dev-server managers", {
          message: "Failed to shutdown dev-server managers",
          ...normalizeErrorForLog(error),
        });
      });
    });

    if (!dashboardApp.__fnWebSocketsAttached) {
      dashboardApp.__fnWebSocketsAttached = true;
      const websocketOptions = { ...options, runtimeLogger };
      setupTerminalWebSocket(dashboardApp, server as HttpServer, store, websocketOptions);
      setupBadgeWebSocket(dashboardApp, server as HttpServer, store, websocketOptions);
      // CLI agent session attach WS (U10) — distinct handler, shares only the
      // upgrade-gate shape with the terminal WS. Mounted only when transport
      // deps are supplied (engine wiring lands in a later unit).
      if (options?.cliSessionTransport) {
        setupCliSessionWebSocket(server as HttpServer, {
          manager: options.cliSessionTransport.manager,
          store: options.cliSessionTransport.store,
          ticketStore: options.cliSessionTransport.ticketStore,
          attributionLog: options.cliSessionTransport.attributionLog,
          daemonToken: getDaemonToken(options),
          noAuth: options?.noAuth,
          extraAllowedOrigins: options.cliSessionTransport.extraAllowedOrigins,
        });
      }
    }

    return server as HttpServer;
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

  // Resolve the daemon token once so every upgrade picks up the same value.
  const wsDaemonToken = getDaemonToken(options);
  const terminalDiagnostics = createTerminalWebSocketDiagnostics(options?.runtimeLogger);

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", `http://${req.headers.host}`).pathname;
    if (pathname !== "/api/terminal/ws") {
      return;
    }

    // When daemon auth is active, refuse WebSocket upgrades that don't
    // carry a valid bearer token. The token can come from the Authorization
    // header (rare for browser WebSocket clients) or the `fn_token` query
    // param (what our own client uses).
    if (wsDaemonToken && !options?.noAuth && !authenticateUpgradeRequest(wsDaemonToken, req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
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
        const scopedStore = await resolveScopedStore(projectId, store, options?.engineManager, options?.engine?.getProjectId?.(), options);
        scopedRootDir = scopedStore.getRootDir();
        terminalService = getTerminalService(scopedRootDir);
      } else {
        // Without projectId, use the default store's root dir
        scopedRootDir = store.getRootDir();
        terminalService = getTerminalService(scopedRootDir);
      }
    } catch (err) {
      terminalDiagnostics.scopeResolutionFailed({
        projectId,
        error: err,
      });
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
      terminalDiagnostics.crossProjectCwdRejected({
        sessionId,
        projectId,
        sessionCwd: session.cwd,
        scopedRootDir,
      });
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
      terminalDiagnostics.staleReconnect({
        sessionId,
        idleMs,
        staleThresholdMs: STALE_SESSION_THRESHOLD_MS,
      });
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
          terminalDiagnostics.ptyExit({
            sessionId: id,
            exitCode,
            idleSeconds: idleSec,
          });
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
          terminalDiagnostics.heartbeatTerminating({
            sessionId,
            missedPongs,
            maxMissedPongs: MAX_MISSED_PONGS,
          });
          ws.terminate();
          return;
        }
        terminalDiagnostics.heartbeatMissed({
          sessionId,
          missedPongs,
          maxMissedPongs: MAX_MISSED_PONGS,
        });
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
    } catch (err) {
      terminalDiagnostics.staleEvictionFailed({ error: err });
    }
  }, 60_000);

  // Stop eviction timer when the server shuts down
  server.once("close", () => {
    clearInterval(staleEvictionInterval);
  });

  terminalDiagnostics.mounted({ path: "/api/terminal/ws" });
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
    scopedStore = await resolveScopedStore(projectId, store, options?.engineManager, options?.engine?.getProjectId?.(), options);
    scopedStores.set(projectId, scopedStore);
    return scopedStore;
  };

  // Prime cache with existing tasks from default store
  void store.listTasks({ slim: true, includeArchived: false, startupMemo: true }).then((tasks) => {
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

  // Resolve the daemon token once per server so every upgrade picks up the
  // same value. See the equivalent block in setupTerminalWebSocket above.
  const badgeWsDaemonToken = getDaemonToken(options);

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", `http://${req.headers.host}`).pathname;
    if (pathname !== "/api/ws") {
      return;
    }

    if (badgeWsDaemonToken && !options?.noAuth && !authenticateUpgradeRequest(badgeWsDaemonToken, req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
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
      // FNXC:BadgeSnapshotEviction 2026-07-10-15:00: evict (not re-cache) when a
      // task is archived off the live board, and skip the publish so peers don't
      // re-cache it. An unarchive re-emits task:updated with a live column and
      // re-primes the entry. See isBadgeEligibleTask.
      if (!isBadgeEligibleTask(task)) {
        badgeSnapshots.delete(cacheKey);
        return;
      }
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
      // FNXC:BadgeSnapshotEviction 2026-07-10-15:00: an already-archived task
      // (e.g. restored/imported into the archive) must not seed the live-board
      // badge cache — same eligibility rule as the update listener.
      if (!isBadgeEligibleTask(task)) {
        badgeSnapshots.delete(cacheKey);
        return;
      }
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
    setRunningAgentCountSource(undefined);
    dashboardApp.terminalWsServer = null;
    dashboardApp.badgeWsServer = null;
    dashboardApp.badgeWsManager = null;
    dashboardApp.__fnWebSocketsAttached = false;
  });
}

/*
FNXC:BadgeSnapshotEviction 2026-07-10-15:00:
The in-memory badge-snapshot cache is keyed by task id and only ever removed a task
on hard-delete, so archived tasks accumulated for the daemon's whole lifetime — a slow
memory leak on long-running servers with task churn. Badge snapshots are only needed for
tasks visible on the live board; archived tasks leave it. This predicate is the single
eligibility rule used by both the create and update listeners (and mirrored by the
startup prime's `includeArchived:false`). Exported for unit coverage of the invariant.
*/
export function isBadgeEligibleTask(task: Pick<Task, "column">): boolean {
  return task.column !== "archived";
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
