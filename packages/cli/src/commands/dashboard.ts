import type { AddressInfo } from "node:net";
import { TaskStore, AutomationStore, CentralCore, AgentStore, PluginStore, PluginLoader, getTaskMergeBlocker, syncInsightExtractionAutomation, INSIGHT_EXTRACTION_SCHEDULE_NAME, processAndAuditInsightExtraction } from "@fusion/core";
import type { Settings, ScheduledTask, AutomationRunResult } from "@fusion/core";
import { createServer, GitHubClient } from "@fusion/dashboard";
import { TriageProcessor, TaskExecutor, Scheduler, AgentSemaphore, WorktreePool, aiMergeTask, UsageLimitPauser, PRIORITY_MERGE, scanIdleWorktrees, cleanupOrphanedWorktrees, NtfyNotifier, PrMonitor, PrCommentHandler, CronRunner, StuckTaskDetector, SelfHealingManager, MissionAutopilot, createAiPromptExecutor, HeartbeatMonitor, HeartbeatTriggerScheduler, type WakeContext } from "@fusion/engine";
import { AuthStorage, DefaultPackageManager, ModelRegistry, SettingsManager, discoverAndLoadExtensions, getAgentDir, createExtensionRuntime } from "@mariozechner/pi-coding-agent";
import {
  getMergeStrategy,
  processPullRequestMergeTask,
} from "./task-lifecycle.js";
import { promptForPort } from "./port-prompt.js";

// Re-export for backward compatibility with tests
export { promptForPort };

type LoginCallbacks = Parameters<AuthStorage["login"]>[1];

interface DashboardAuthStorage {
  reload(): void;
  getOAuthProviders(): Array<{ id: string; name: string }>;
  hasAuth(provider: string): boolean;
  login(providerId: string, callbacks: LoginCallbacks): Promise<void>;
  logout(provider: string): void;
  getApiKeyProviders(): Array<{ id: string; name: string }>;
  setApiKey(providerId: string, apiKey: string): void;
  clearApiKey(providerId: string): void;
  hasApiKey(providerId: string): boolean;
}

function getProviderDisplayName(providerId: string): string {
  const knownProviderNames: Record<string, string> = {
    openrouter: "OpenRouter",
    "kimi-coding": "Kimi",
  };

  if (knownProviderNames[providerId]) {
    return knownProviderNames[providerId];
  }

  return providerId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function wrapAuthStorageWithApiKeyProviders(
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
): DashboardAuthStorage {
  return {
    reload: () => authStorage.reload(),
    getOAuthProviders: () =>
      authStorage
        .getOAuthProviders()
        .map((provider) => ({ id: provider.id, name: provider.name })),
    hasAuth: (provider) => authStorage.hasAuth(provider),
    login: (providerId, callbacks) =>
      authStorage.login(providerId as Parameters<AuthStorage["login"]>[0], callbacks),
    logout: (provider) => authStorage.logout(provider),
    getApiKeyProviders: () => {
      const oauthProviderIds = new Set(
        authStorage.getOAuthProviders().map((provider) => provider.id),
      );
      const providers = new Map<string, string>();

      for (const model of modelRegistry.getAll()) {
        const providerId = model.provider;
        if (!providerId || oauthProviderIds.has(providerId) || providers.has(providerId)) {
          continue;
        }
        providers.set(providerId, getProviderDisplayName(providerId));
      }

      return Array.from(providers, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
    setApiKey: (providerId, apiKey) => {
      authStorage.set(providerId, { type: "api_key", key: apiKey });
    },
    clearApiKey: (providerId) => {
      authStorage.remove(providerId);
    },
    hasApiKey: (providerId) => {
      const credential = authStorage.get(providerId);
      return credential?.type === "api_key" || authStorage.hasAuth(providerId);
    },
  };
}

export async function runDashboard(port: number, opts: { paused?: boolean; dev?: boolean; interactive?: boolean; open?: boolean } = {}) {
  // Handle interactive port selection
  let selectedPort = port;
  if (opts.interactive) {
    try {
      selectedPort = await promptForPort(port);
    } catch (err: any) {
      if (err.message === "Interactive prompt cancelled") {
        console.log("Cancelled — exiting");
        process.exit(0);
      }
      throw err;
    }
  }
  const cwd = process.cwd();
  const store = new TaskStore(cwd);
  await store.init();
  await store.watch();

  const handlers: Array<{
    target: NodeJS.EventEmitter;
    event: string | symbol;
    handler: (...args: any[]) => void;
  }> = [];
  let disposed = false;
  let mergeRetryTimer: ReturnType<typeof setTimeout> | null = null;

  function registerHandler(
    target: NodeJS.EventEmitter,
    event: string | symbol,
    handler: (...args: any[]) => void,
  ): void {
    target.on(event, handler);
    handlers.push({ target, event, handler });
  }

  // ── AutomationStore: scheduled task persistence ──────────────────────
  const automationStore = new AutomationStore(cwd);
  await automationStore.init();

  // ── AgentStore: agent lifecycle tracking ──────────────────────────
  //
  // Tracks spawned agents so they appear in the dashboard's Agents view
  // and are properly managed throughout their lifecycle (creation, state
  // transitions, termination). Passed to TaskExecutor for agent spawning.
  //
  const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
  await agentStore.init();

  // ── PluginStore: plugin installation management ─────────────────────
  //
  // SQLite-backed plugin persistence for the Settings → Plugins experience.
  // Enables the PluginManager UI to list, install, enable, disable, and
  // configure plugins via the /api/plugins REST endpoints.
  //
  const pluginStore = new PluginStore(store.getFusionDir());
  await pluginStore.init();

  // ── PluginLoader: plugin lifecycle management ───────────────────────
  //
  // Manages dynamic plugin loading, hot-reload, hook invocation, and
  // dependency resolution. The PluginLoader instance also serves as the
  // PluginRunner for the REST routes (provides getPluginRoutes and
  // reloadPlugin methods).
  //
  const pluginLoader = new PluginLoader({
    pluginStore,
    taskStore: store,
  });

  // ── HeartbeatMonitor: runtime monitoring (UTILITY — NO semaphore) ───
  //
  // ⚠️ UTILITY PATH: This component does NOT receive the task-lane semaphore.
  //
  // Provides the Paperclip-style heartbeat execution engine:
  //   wake → check inbox → work → exit
  //
  // Enables lightweight agent sessions for monitoring, not task-lane work.
  // By design, heartbeat sessions are independent of task concurrency limits
  // so they can run regardless of how busy the task lanes are.
  //
  // Passed to createServer to enable the dashboard's heartbeat routes.
  //
  let heartbeatMonitor: HeartbeatMonitor | undefined;
  let triggerScheduler: HeartbeatTriggerScheduler | undefined;
  try {
    heartbeatMonitor = new HeartbeatMonitor({
      store: agentStore,
      agentStore: agentStore, // enables per-agent config resolution
      taskStore: store,
      rootDir: cwd,
      onMissed: (agentId) => {
        console.log(`[engine] Agent ${agentId} missed heartbeat`);
      },
      onTerminated: (agentId) => {
        console.log(`[engine] Agent ${agentId} terminated (unresponsive)`);
      },
    });
    heartbeatMonitor.start();

    // HeartbeatTriggerScheduler: trigger scheduling (UTILITY — NO semaphore) ──
    //
    // ⚠️ UTILITY PATH: This scheduler does NOT receive the task-lane semaphore.
    //
    // Manages timer and assignment-based triggers for heartbeat execution.
    // By design, trigger scheduling is independent of task-lane concurrency limits.
    //
    triggerScheduler = new HeartbeatTriggerScheduler(
      agentStore,
      async (agentId, source, context: WakeContext) => {
        if (!heartbeatMonitor) return;
        await heartbeatMonitor.executeHeartbeat({
          agentId,
          source,
          triggerDetail: context.triggerDetail,
          taskId: typeof context.taskId === "string" ? context.taskId : undefined,
          triggeringCommentIds: Array.isArray(context.triggeringCommentIds)
            ? context.triggeringCommentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
            : undefined,
          triggeringCommentType:
            context.triggeringCommentType === "steering"
            || context.triggeringCommentType === "task"
            || context.triggeringCommentType === "pr"
              ? context.triggeringCommentType
              : undefined,
          contextSnapshot: { ...context },
        });
      },
      store,
    );
    triggerScheduler.start();

    // Register existing agents that have heartbeat config
    const agents = await agentStore.listAgents();
    for (const agent of agents) {
      const rc = agent.runtimeConfig;
      if (rc && (rc.heartbeatIntervalMs || rc.enabled !== undefined || rc.maxConcurrentRuns)) {
        triggerScheduler.registerAgent(agent.id, {
          heartbeatIntervalMs: rc.heartbeatIntervalMs as number | undefined,
          enabled: rc.enabled as boolean | undefined,
          maxConcurrentRuns: rc.maxConcurrentRuns as number | undefined,
        });
      }
    }
    if (agents.length > 0) {
      console.log(`[engine] Registered ${triggerScheduler.getRegisteredAgents().length} agents for heartbeat triggers`);
    }
  } catch (err) {
    // Non-fatal — agent monitoring is optional
    console.log(`[engine] HeartbeatMonitor initialization failed (continuing without agent monitoring):`, err);
  }

  // ── NtfyNotifier: push notifications for task completion and failures ─
  //
  // Resolve the project ID from the central registry so that notification
  // deep links include ?project=...&task=... for multi-project dashboards.
  // Falls back to no project ID (task-only links) when the central DB is
  // unavailable or the project is not registered (single-project / legacy).
  //
  let ntfyProjectId: string | undefined;
  try {
    const central = new CentralCore();
    await central.init();
    const registered = await central.getProjectByPath(cwd);
    await central.close();
    if (registered) {
      ntfyProjectId = registered.id;
    }
  } catch {
    // Central DB unavailable or project not registered — backward compatible
  }
  const notifier = new NtfyNotifier(store, { projectId: ntfyProjectId });
  notifier.start();

  // Set enginePaused if starting in paused mode
  if (opts.paused) {
    await store.updateSettings({ enginePaused: true });
    console.log("[engine] Starting in paused mode — automation disabled");
  }

  // ── Task-lane concurrency semaphore ────────────────────────────────
  //
  // ⚠️ SEMAPHORE BOUNDARY: This semaphore governs ONLY task-lane agents.
  //
  // Governed components (task lanes):
  //   - TriageProcessor: specification agents that produce PROMPT.md
  //   - TaskExecutor: task execution agents that implement features
  //   - Scheduler: coordinates which agent gets which task
  //   - onMerge: AI-powered merge execution for completed tasks
  //
  // UTILITY WORKFLOWS — NOT governed by this semaphore:
  //   - HeartbeatMonitor: lightweight heartbeat sessions for agent monitoring
  //   - HeartbeatTriggerScheduler: timer/assignment-based trigger scheduling
  //   - CronRunner (via createAiPromptExecutor): scheduled automation prompts
  //   - Model sync, auth setup, plugin loading: bootstrap/setup workflows
  //
  // This boundary prevents utility workflows from being blocked by
  // task-lane saturation and ensures utility work is always available.
  //
  // The limit is read from a cached value that is refreshed from the store
  // on each scheduler poll cycle (see engine block below). This avoids
  // async I/O in the synchronous getter while still picking up live changes.
  //
  const initialSettings = await store.getSettings();
  let cachedMaxConcurrent = initialSettings.maxConcurrent;
  const semaphore = new AgentSemaphore(() => cachedMaxConcurrent);

  // ── Shared worktree pool ──────────────────────────────────────────
  //
  // Enables worktree recycling across tasks when `recycleWorktrees` is
  // enabled in settings. Completed task worktrees are returned to the
  // pool instead of being deleted; new tasks acquire a warm worktree
  // preserving build caches (node_modules, dist/, etc.).
  //
  // Created unconditionally — the `recycleWorktrees` gating logic lives
  // inside TaskExecutor and aiMergeTask (see HAI-037). When the setting
  // is off the pool simply stays empty.
  //
  const pool = new WorktreePool();

  // ── Startup: rehydrate or clean up worktrees from previous runs ────
  //
  // When `recycleWorktrees` is true, scan the .worktrees/ directory for
  // idle worktrees (not assigned to any active task) and load them into
  // the pool so new tasks can reuse them instead of creating fresh ones.
  //
  // When `recycleWorktrees` is false, clean up orphaned worktrees left
  // behind by previous engine runs to avoid disk waste.
  //
  if (initialSettings.recycleWorktrees) {
    const idlePaths = await scanIdleWorktrees(cwd, store);
    if (idlePaths.length > 0) {
      pool.rehydrate(idlePaths);
      console.log(`[engine] Rehydrated pool with ${idlePaths.length} idle worktree(s)`);
    }
  } else {
    const cleaned = await cleanupOrphanedWorktrees(cwd, store);
    if (cleaned > 0) {
      console.log(`[engine] Cleaned up ${cleaned} orphaned worktree(s)`);
    }
  }

  // ── Usage limit pauser ──────────────────────────────────────────────
  //
  // Shared pauser that triggers globalPause when any agent hits an API
  // usage limit (rate limits, overloaded, quota exceeded). A single
  // instance is shared across triage, executor, and merger so that the
  // pause is deduplicated across concurrent agents.
  //
  const usageLimitPauser = new UsageLimitPauser(store);
  const githubClient = new GitHubClient();

  // ── onMerge: AI-powered merge (TASK LANE — semaphore-gated) ─────────────
  //
  // ⚠️ TASK LANE: aiMergeTask is wrapped with semaphore.run() to ensure
  // merge agents count toward settings.maxConcurrent alongside triage and execution.
  //
  // The raw aiMergeTask does NOT receive the semaphore directly;
  // the semaphore gating is applied at the onMerge wrapper level.
  //
  // Track the active merge session so it can be killed on global pause.
  let activeMergeSession: { dispose: () => void } | null = null;

  const rawMerge = (taskId: string) =>
    aiMergeTask(store, cwd, taskId, {
      pool,
      usageLimitPauser,
      agentStore,
      onAgentText: (delta) => process.stdout.write(delta),
      onSession: (session) => { activeMergeSession = session; },
    });

  const onMerge = (taskId: string) => semaphore.run(() => rawMerge(taskId), PRIORITY_MERGE);

  // When globalPause transitions from false → true, terminate the active merge session.
  registerHandler(store, "settings:updated", ({ settings, previous }) => {
    if (settings.globalPause && !previous.globalPause) {
      if (activeMergeSession) {
        console.log("[auto-merge] Global pause — terminating active merge session");
        activeMergeSession.dispose();
        activeMergeSession = null;
      }
    }
  });

  // ── Serialized auto-merge queue ─────────────────────────────────────
  //
  // Three paths feed into this queue:
  //   1. Event-driven: `task:moved` → "in-review" (immediate reaction)
  //   2. Startup sweep: tasks already in "in-review" when the engine starts
  //   3. Periodic retry: a setInterval catches tasks stuck in "in-review"
  //      after a previous merge attempt failed
  //
  // The queue ensures only one `aiMergeTask` runs at a time, preventing
  // concurrent git merge operations in rootDir. Task IDs in the queue or
  // actively being processed are tracked in `mergeActive` so the periodic
  // sweep doesn't re-enqueue them.
  //
  const mergeQueue: string[] = [];
  const mergeActive = new Set<string>(); // IDs queued or currently merging
  let mergeRunning = false;
  const maxAutoMergeRetries = 3;

  function hasAutoHealableVerificationBufferFailure(task: {
    mergeRetries?: number | null;
    column: string;
    error?: string | null;
    log?: Array<{ action?: string }>;
  }): boolean {
    if (task.column !== "in-review") return false;
    if ((task.mergeRetries ?? 0) < maxAutoMergeRetries) return false;
    if (!task.error?.includes("Deterministic test verification failed")) return false;

    return task.log?.some((entry) =>
      entry.action?.includes("[verification] test command failed (exit 0)")
      || entry.action?.includes("[verification] build command failed (exit 0)")
      || entry.action?.includes("output exceeded buffer"),
    ) ?? false;
  }

  function canAutoMergeTask(task: { mergeRetries?: number | null; column: string; paused?: boolean; status?: string | null; error?: string | null; steps?: Array<{ status: string }>; workflowStepResults?: Array<{ status: string }>; log?: Array<{ action?: string }> }): boolean {
    if (getTaskMergeBlocker(task as any)) return false;
    return (task.mergeRetries ?? 0) < maxAutoMergeRetries
      || hasAutoHealableVerificationBufferFailure(task);
  }

  /** Enqueue a task for auto-merge if not already queued/active. */
  function enqueueMerge(taskId: string): void {
    if (mergeActive.has(taskId)) return;
    mergeActive.add(taskId);
    mergeQueue.push(taskId);
    drainMergeQueue();
  }

  /** Process the merge queue sequentially. */
  async function drainMergeQueue(): Promise<void> {
    if (mergeRunning) return;
    mergeRunning = true;
    try {
      while (mergeQueue.length > 0) {
        const taskId = mergeQueue.shift()!;
        try {
          // Re-check autoMerge and globalPause before each merge (setting may have been toggled)
          const settings = await store.getSettings();
          if (settings.globalPause || settings.enginePaused) {
            console.log(`[auto-merge] Skipping ${taskId} — ${settings.globalPause ? "global pause" : "engine paused"} active`);
            continue;
          }
          if (!settings.autoMerge) {
            console.log(`[auto-merge] Skipping ${taskId} — autoMerge disabled`);
            continue;
          }
          // Verify the task is still in-review and not paused
          const task = await store.getTask(taskId);
          if (!canAutoMergeTask(task as any)) {
            continue;
          }
          if (hasAutoHealableVerificationBufferFailure(task as any)) {
            await store.logEntry(
              taskId,
              "Auto-healing stale deterministic verification buffer failure; retrying merge verification",
            );
            await store.updateTask(taskId, { mergeRetries: 0, error: null, status: null });
          }
          const mergeStrategy = getMergeStrategy(settings);
          if (mergeStrategy === "pull-request") {
            console.log(`[auto-merge] Processing PR flow for ${taskId}...`);
            const result = await processPullRequestMergeTask(store, cwd, taskId, githubClient, getTaskMergeBlocker);
            if (result === "merged") {
              console.log(`[auto-merge] ✓ ${taskId} merged via pull request`);
            } else if (result === "waiting") {
              console.log(`[auto-merge] … ${taskId} waiting on PR checks or reviews`);
            }
          } else {
            console.log(`[auto-merge] Merging ${taskId}...`);
            await onMerge(taskId);
            console.log(`[auto-merge] ✓ ${taskId} merged`);
            // Clear mergeRetries on success
            if (task.mergeRetries && task.mergeRetries > 0) {
              await store.updateTask(taskId, { mergeRetries: 0 });
            }
          }
        } catch (err: any) {
          const errorMsg = err.message ?? String(err);
          console.log(`[auto-merge] ✗ ${taskId}: ${errorMsg}`);

          const settings = await store.getSettings().catch(() => ({ autoResolveConflicts: true, mergeStrategy: "direct" as const }));
          const task = await store.getTask(taskId).catch(() => null);
          const mergeStrategy = getMergeStrategy(settings);

          if (mergeStrategy === "direct") {
            // Check if this is a conflict error and if we should retry
            const isConflictError = errorMsg.includes("conflict") || errorMsg.includes("Conflict");

            if (task && isConflictError) {
              const currentRetries = task.mergeRetries ?? 0;
              const maxRetries = maxAutoMergeRetries;

              if (settings.autoResolveConflicts !== false && currentRetries < maxRetries) {
                // Increment retry counter and re-enqueue with delay
                const newRetryCount = currentRetries + 1;
                await store.updateTask(taskId, { mergeRetries: newRetryCount, status: null });

                // Calculate exponential backoff delay: 5s, 10s, 20s
                const delayMs = 5000 * Math.pow(2, currentRetries);
                console.log(`[auto-merge] ↻ ${taskId}: retry ${newRetryCount}/${maxRetries} in ${delayMs / 1000}s`);

                setTimeout(() => {
                  enqueueMerge(taskId);
                }, delayMs);
              } else {
                // Max retries exceeded or auto-resolve disabled - keep in in-review
                if (currentRetries >= maxRetries) {
                  console.log(`[auto-merge] ⊘ ${taskId}: max retries (${maxRetries}) exceeded — manual resolution required`);
                } else {
                  console.log(`[auto-merge] ⊘ ${taskId}: autoResolveConflicts disabled — manual resolution required`);
                }
                // Reset task status so it doesn't appear stuck as "merging" in the UI
                try {
                  await store.updateTask(taskId, { status: null });
                } catch { /* best-effort */ }
              }
            } else {
              // Non-conflict error - stop auto-retrying until a user intervenes.
              // This prevents the periodic sweep from re-enqueueing the same
              // broken merge on every poll cycle.
              try {
                await store.updateTask(taskId, {
                  status: null,
                  mergeRetries: maxAutoMergeRetries,
                  error: errorMsg,
                });
              } catch { /* best-effort */ }
            }
          } else {
            try {
              await store.updateTask(taskId, {
                status: null,
                mergeRetries: maxAutoMergeRetries,
                error: errorMsg,
              });
            } catch { /* best-effort */ }
          }
        } finally {
          mergeActive.delete(taskId);
        }
      }
    } finally {
      mergeRunning = false;
    }
  }

  // Auto-merge: when a task lands in "in-review" and autoMerge is enabled,
  // enqueue it for serialized merge processing.
  registerHandler(store, "task:moved", async ({ task, to }) => {
    if (to !== "in-review") return;
    if (getTaskMergeBlocker(task)) return;
    try {
      const settings = await store.getSettings();
      if (settings.globalPause || settings.enginePaused) return;
      if (!settings.autoMerge) return;
      enqueueMerge(task.id);
    } catch { /* ignore settings read errors */ }
  });

  // ── Auth & model wiring ────────────────────────────────────────────
  // AuthStorage manages OAuth/API-key credentials (stored in ~/.pi/agent/auth.json).
  // ModelRegistry discovers available models from configured providers.
  // Passing these to createServer enables the dashboard's Authentication
  // tab (login/logout) and Model selector.
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  try {
    // Resolve extension paths from pi settings packages (npm, git, local).
    // This picks up extensions like @howaboua/pi-glm-via-anthropic that
    // register custom providers (e.g. glm-5.1) via registerProvider().
    const agentDir = getAgentDir();
    const piSettingsManager = SettingsManager.create(cwd, agentDir);
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: piSettingsManager,
    });
    const resolvedPaths = await packageManager.resolve();
    const packageExtensionPaths = resolvedPaths.extensions
      .filter((r) => r.enabled)
      .map((r) => r.path);

    // Load all extensions: filesystem-discovered + package-resolved
    const extensionsResult = await discoverAndLoadExtensions(packageExtensionPaths, cwd, undefined);

    for (const { path, error } of extensionsResult.errors) {
      console.log(`[extensions] Failed to load ${path}: ${error}`);
    }

    for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[extensions] Failed to register provider from ${extensionPath}: ${message}`);
      }
    }

    extensionsResult.runtime.pendingProviderRegistrations = [];
    modelRegistry.refresh();

    // Eagerly sync OpenRouter models — the pi-openrouter-realtime extension
    // only registers providers on session_start (TUI-only event), so kick off
    // a fetch here so the dashboard model list is populated. Respects the
    // openrouterModelSync setting (defaults to true).
    (async () => {
      try {
        const settings = await store.getSettings();
        if (settings.openrouterModelSync === false) return;
        const hasOrAuth = await authStorage.getApiKey("openrouter");
        const headers: Record<string, string> = {};
        if (hasOrAuth) headers["Authorization"] = `Bearer ${hasOrAuth}`;
        const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
        if (!res.ok) return;
        const json = await res.json() as { data?: Array<{ id: string; name: string; context_length?: number; top_provider?: { max_completion_tokens?: number }; pricing?: Record<string, string>; architecture?: { modality?: string; input_modalities?: string[] } }> };
        const orModels = (json.data || []).map((m: any) => {
          const id = (m.id || "").toLowerCase();
          const name = (m.name || "").toLowerCase();
          const reasoning = id.includes(":thinking") || id.includes("-r1") || id.includes("/r1") || id.includes("o1-") || id.includes("o3-") || id.includes("o4-") || id.includes("reasoner") || name.includes("thinking") || name.includes("reasoner");
          const hasVision = m.architecture?.input_modalities?.includes("image") ?? m.architecture?.modality?.includes("multimodal") ?? false;
          function parseCost(v?: string) { const n = parseFloat(v || "0"); return isNaN(n) ? 0 : n * 1_000_000; }
          return {
            id: m.id,
            name: m.name || m.id,
            reasoning,
            input: (hasVision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
            cost: { input: parseCost(m.pricing?.prompt), output: parseCost(m.pricing?.completion), cacheRead: parseCost(m.pricing?.input_cache_read), cacheWrite: parseCost(m.pricing?.input_cache_write) },
            contextWindow: m.context_length || 128000,
            maxTokens: m.top_provider?.max_completion_tokens || 16384,
          };
        });
        modelRegistry.registerProvider("openrouter", {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "OPENROUTER_API_KEY",
          api: "openai-completions",
          models: orModels,
        });
        console.log(`[openrouter] Synced ${orModels.length} models from OpenRouter API`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[openrouter] Failed to sync models: ${message}`);
      }
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[extensions] Failed to discover extensions: ${message}`);
    createExtensionRuntime();
    modelRegistry.refresh();
  }

  // ── MissionAutopilot: autonomous mission progression ─────────────
  //
  // Created before createServer so it can be passed to both the server
  // and the Scheduler. The scheduler reference is set after Scheduler
  // construction via setScheduler() to break the circular dependency.
  // In dev mode the autopilot is created but never started.
  //
  const missionAutopilot = new MissionAutopilot(store, store.getMissionStore());

  const dashboardAuthStorage = wrapAuthStorageWithApiKeyProviders(authStorage, modelRegistry);

  // Start the web server with AI merge, auth, model registry, and plugin wiring
  const app = createServer(store, {
    onMerge,
    authStorage: dashboardAuthStorage,
    modelRegistry,
    automationStore,
    missionAutopilot,
    heartbeatMonitor,
    pluginStore,
    pluginLoader,
    pluginRunner: pluginLoader,
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    for (const { target, event, handler } of handlers) {
      target.off(event, handler);
    }
    handlers.length = 0;

    if (mergeRetryTimer) {
      clearTimeout(mergeRetryTimer);
      mergeRetryTimer = null;
    }
  }

  // Start the AI engine (unless in dev mode)
  if (!opts.dev) {
    // ── Self-healing: auto-unpause, stuck kill budgets, maintenance ─────
    const selfHealing = new SelfHealingManager(store, {
      rootDir: cwd,
      recoverCompletedTask: (task) => executorRef.current?.recoverCompletedTask(task) ?? Promise.resolve(false),
      getExecutingTaskIds: () => executorRef.current?.getExecutingTaskIds() ?? new Set(),
      recoverApprovedTriageTask: (task) => triageRef.current?.recoverApprovedTask(task) ?? Promise.resolve(false),
      getSpecifyingTaskIds: () => triageRef.current?.getProcessingTaskIds() ?? new Set(),
    });

    // ── Stuck task detector: monitors agent sessions for stagnation ────
    // Created before triage/executor so it can be passed in options.
    // The onStuck callback is wired via late-binding closures on triageRef
    // and executorRef to avoid circular construction order dependencies.
    const executorRef: { current: TaskExecutor | null } = { current: null };
    const triageRef: { current: TriageProcessor | null } = { current: null };
    const stuckTaskDetector = new StuckTaskDetector(store, {
      beforeRequeue: (taskId) => selfHealing.checkStuckBudget(taskId),
      onLoopDetected: (event) => executorRef.current?.handleLoopDetected(event) ?? Promise.resolve(false),
      onStuck: (event) => {
        // Notify whichever component owns this task (triage or executor).
        // Both check their own tracking sets so only the owner acts.
        triageRef.current?.markStuckAborted(event.taskId);
        executorRef.current?.markStuckAborted(event.taskId, event.shouldRequeue);
        console.log(
          `[engine] ⚠ ${event.taskId} stuck (${event.reason}) — ` +
          `no progress for ${Math.round(event.noProgressMs / 60_000)}min, ` +
          `${event.activitySinceProgress} events since last progress — ` +
          `terminated, ${event.shouldRequeue ? "will retry" : "budget exhausted"}`,
        );
      },
    });

    // ── TriageProcessor: task specification (TASK LANE — receives semaphore) ──
    //
    // Receives the task-lane semaphore to ensure specification agents
    // count toward settings.maxConcurrent alongside execution and merge.
    //
    const triage = new TriageProcessor(store, cwd, {
      semaphore,
      usageLimitPauser,
      stuckTaskDetector,
      agentStore,
      onSpecifyStart: (t) => console.log(`[engine] Specifying ${t.id}...`),
      onSpecifyComplete: (t) => console.log(`[engine] ✓ ${t.id} → todo`),
      onSpecifyError: (t, e) => console.log(`[engine] ✗ ${t.id}: ${e.message}`),
    });
    triageRef.current = triage;

    // ── TaskExecutor: task execution (TASK LANE — receives semaphore) ──────────
    //
    // Receives the task-lane semaphore to ensure execution agents
    // count toward settings.maxConcurrent alongside specification and merge.
    //
    const executor = new TaskExecutor(store, cwd, {
      semaphore,
      pool,
      usageLimitPauser,
      stuckTaskDetector,
      agentStore,
      onStart: (t, p) => console.log(`[engine] Executing ${t.id} in ${p}`),
      onComplete: (t) => console.log(`[engine] ✓ ${t.id} → in-review`),
      onError: (t, e) => console.log(`[engine] ✗ ${t.id}: ${e.message}`),
    });
    executorRef.current = executor;

    const settings = await store.getSettings();
    const prMonitor = new PrMonitor();
    const prCommentHandler = new PrCommentHandler(store);
    prMonitor.onNewComments((taskId, prInfo, comments) =>
      prCommentHandler.handleNewComments(taskId, prInfo, comments),
    );

    // ── MissionAutopilot is already created above (before createServer) ──
    // The scheduler reference is set after construction via setScheduler()
    // to break the circular dependency.

    // ── Scheduler: task coordination (TASK LANE — receives semaphore) ──────────
    //
    // Receives the task-lane semaphore to ensure task assignment decisions
    // respect the concurrency limit alongside running execution agents.
    //
    const scheduler = new Scheduler(store, {
      semaphore,
      prMonitor,
      missionStore: store.getMissionStore(),
      missionAutopilot,
      onSchedule: (t) => console.log(`[engine] Scheduled ${t.id}`),
      onBlocked: (t, deps) => console.log(`[engine] ${t.id} blocked by ${deps.join(", ")}`),
      onClosedPrFeedback: async (taskId, prInfo, comments) => {
        await prCommentHandler.createFollowUpTask(taskId, prInfo, comments);
      },
    });

    // Break circular dependency: Scheduler ↔ MissionAutopilot
    missionAutopilot.setScheduler(scheduler);

    // ── CronRunner: scheduled task execution ──────────────────────────

    // Post-run callback for memory insight extraction processing
    const onMemoryInsightRunProcessed = async (
      schedule: ScheduledTask,
      result: AutomationRunResult,
    ): Promise<void> => {
      // Only process the memory insight extraction schedule
      if (schedule.name !== INSIGHT_EXTRACTION_SCHEDULE_NAME) {
        return;
      }

      // Extract the AI step output from the result
      const stepResults = result.stepResults ?? [];
      // Step name updated in FN-1477 to include pruning
      const aiStep = stepResults.find(
        (sr) => sr.stepName === "Extract Memory Insights and Prune" || sr.stepName === "Extract Memory Insights",
      );

      if (!aiStep) {
        console.log(`[memory-audit] No insight extraction step found in ${schedule.name} result`);
        return;
      }

      console.log(`[memory-audit] Processing memory insight extraction run...`);

      try {
        const auditReport = await processAndAuditInsightExtraction(cwd, {
          rawResponse: aiStep.output ?? "",
          stepSuccess: aiStep.success,
          runAt: result.startedAt,
          error: aiStep.error,
        });

        const pruneStatus = auditReport.pruning.applied
          ? ` | Pruned: ${auditReport.pruning.originalSize} → ${auditReport.pruning.newSize} chars`
          : ` | Pruning: ${auditReport.pruning.reason}`;

        console.log(
          `[memory-audit] ✓ Audit complete — Health: ${auditReport.health}, ` +
          `Insights: ${auditReport.insightsMemory.insightCount}${pruneStatus}`,
        );
      } catch (err) {
        console.error(
          `[memory-audit] ✗ Failed to process insight extraction: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    // ── CronRunner: scheduled automation (UTILITY — NO semaphore) ──────────
    //
    // ⚠️ UTILITY PATH: CronRunner does NOT receive the task-lane semaphore.
    //
    // Uses createAiPromptExecutor (cwd-only factory) for AI execution in
    // scheduled tasks. By design, automation prompts are independent of
    // task concurrency limits so they can run regardless of task-lane saturation.
    //
    // createAiPromptExecutor takes only `cwd` (no semaphore parameter),
    // ensuring automation never competes with task-lane agents for slots.
    //
    const aiPromptExecutor = await createAiPromptExecutor(cwd);
    const cronRunner = new CronRunner(store, automationStore, {
      aiPromptExecutor,
      onScheduleRunProcessed: onMemoryInsightRunProcessed,
    });

    // ── Sync insight extraction automation on startup ─────────────────
    // Run sync BEFORE starting the cron runner to avoid stale config races.
    // This ensures the insight extraction schedule is created/updated/deleted
    // before the first tick can execute it.
    try {
      await syncInsightExtractionAutomation(automationStore, settings);
    } catch (err) {
      console.error(
        `[memory-audit] Failed to sync insight extraction automation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    cronRunner.start();

    triage.start();
    scheduler.start();
    missionAutopilot.start();
    stuckTaskDetector.start();
    selfHealing.start();

    // ── Startup sweep: resume orphaned in-progress tasks ──────────────
    executor.resumeOrphaned().catch((err) =>
      console.error("[engine] Failed to resume orphaned tasks:", err),
    );

    // ── Startup sweep: enqueue any tasks already in "in-review" ───────
    if (settings.autoMerge) {
      const existing = await store.listTasks();
      const inReview = existing.filter((t) => canAutoMergeTask(t as any));
      if (inReview.length > 0) {
        console.log(
          `[auto-merge] Startup sweep: enqueueing ${inReview.length} in-review task(s)`,
        );
        for (const t of inReview) {
          enqueueMerge(t.id);
        }
      }
    }

    // ── Always sync semaphore limit on any settings change ────────────
    // Without this, changing maxConcurrent in the dashboard has no effect
    // on the semaphore until an unpause transition or merge retry fires.
    registerHandler(store, "settings:updated", ({ settings: s }) => {
      if (s.maxConcurrent !== undefined) {
        cachedMaxConcurrent = s.maxConcurrent;
      }
    });

    // ── Immediate unpause: resume orphans + merge sweep ─────────────
    // When globalPause transitions from true → false, immediately:
    // 1. Resume orphaned in-progress tasks whose agents were killed by pause
    // 2. Sweep the merge queue for in-review tasks that need merging
    registerHandler(store, "settings:updated", async ({ settings: s, previous: prev }) => {
      if (prev.globalPause && !s.globalPause) {
        console.log("[engine] Global unpause — resuming agentic activity");

        executor.resumeOrphaned().catch((err) =>
          console.error("[engine] Failed to resume orphaned tasks on unpause:", err),
        );

        if (s.autoMerge) {
          try {
            const tasks = await store.listTasks();
            for (const t of tasks) {
              if (canAutoMergeTask(t as any)) {
                enqueueMerge(t.id);
              }
            }
          } catch { /* ignore errors in unpause sweep */ }
        }
      }
    });

    // ── Immediate engine-unpause: resume orphans + merge sweep ────────
    // When enginePaused transitions from true → false, same resume logic
    // as globalPause unpause: pick up orphaned tasks and sweep merge queue.
    registerHandler(store, "settings:updated", async ({ settings: s, previous: prev }) => {
      if (prev.enginePaused && !s.enginePaused) {
        console.log("[engine] Engine unpaused — resuming agentic activity");

        executor.resumeOrphaned().catch((err) =>
          console.error("[engine] Failed to resume orphaned tasks on engine unpause:", err),
        );

        if (s.autoMerge) {
          try {
            const tasks = await store.listTasks();
            for (const t of tasks) {
              if (canAutoMergeTask(t as any)) {
                enqueueMerge(t.id);
              }
            }
          } catch { /* ignore errors in unpause sweep */ }
        }
      }
    });

    // ── Stuck task timeout change: immediate check ────────────────────
    // When taskStuckTimeoutMs is changed (e.g., user reduces timeout),
    // immediately check for stuck tasks under the new timer value.
    registerHandler(store, "settings:updated", async ({ settings: s, previous: prev }) => {
      if (s.taskStuckTimeoutMs !== prev.taskStuckTimeoutMs) {
        try {
          console.log(`[stuck-detector] Timeout changed to ${s.taskStuckTimeoutMs}ms — running immediate check`);
          await stuckTaskDetector.checkNow();
        } catch (err) {
          console.error("[stuck-detector] Error during immediate stuck-task check:", err);
        }
      }
    });

    // ── Insight extraction automation sync on settings change ─────────
    // When insight extraction settings change (enable/disable/schedule/min interval),
    // resync the automation schedule without requiring a restart.
    registerHandler(store, "settings:updated", async ({ settings: s, previous: prev }) => {
      const insightKeys = [
        "insightExtractionEnabled",
        "insightExtractionSchedule",
        "insightExtractionMinIntervalMs",
      ] as const;

      const relevantKeyChanged = insightKeys.some((key) => s[key] !== prev[key]);
      if (relevantKeyChanged) {
        try {
          await syncInsightExtractionAutomation(automationStore, s);
          console.log("[memory-audit] Insight extraction automation synced with settings");
        } catch (err) {
          console.error(
            `[memory-audit] Failed to sync insight extraction automation: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

    // ── Periodic retry: catch failed merges on each poll cycle ────────
    // Uses a setTimeout chain so the interval dynamically follows
    // settings.pollIntervalMs without requiring an engine restart.
    // The readiness predicate uses canAutoMergeTask() to detect tasks that
    // have become unblocked while respecting retry limits.
    async function scheduleMergeRetry(): Promise<void> {
      if (disposed) return;
      const currentSettings = await store.getSettings().catch(() => settings);
      const interval = currentSettings.pollIntervalMs ?? 15_000;
      mergeRetryTimer = setTimeout(async () => {
        if (disposed) return;
        try {
          const s = await store.getSettings();
          // Refresh the cached limit so the semaphore picks up live changes
          cachedMaxConcurrent = s.maxConcurrent;
          if (!s.globalPause && !s.enginePaused && s.autoMerge) {
            const tasks = await store.listTasks();
            for (const t of tasks) {
              if (canAutoMergeTask(t as any)) {
                enqueueMerge(t.id);
              }
            }
          }
        } catch { /* ignore errors in periodic sweep */ }
        if (!disposed) {
          scheduleMergeRetry();
        }
      }, interval);
    }
    // Kick off the first retry after the current poll interval
    scheduleMergeRetry();

    const shutdown = () => {
      dispose();
      // Stop heartbeat components first (they reference agentStore)
      if (triggerScheduler) triggerScheduler.stop();
      if (heartbeatMonitor) heartbeatMonitor.stop();
      selfHealing.stop();
      stuckTaskDetector.stop();
      missionAutopilot.stop();
      triage.stop();
      scheduler.stop();
      cronRunner.stop();
      notifier.stop();
      store.close();
      process.exit(0);
    };
    registerHandler(process, "SIGINT", shutdown);
    registerHandler(process, "SIGTERM", shutdown);
  }

  // Dev mode: simplified shutdown handlers (no engine components)
  if (opts.dev) {
    const devShutdown = () => {
      dispose();
      if (triggerScheduler) triggerScheduler.stop();
      if (heartbeatMonitor) heartbeatMonitor.stop();
      notifier.stop();
      store.close();
      process.exit(0);
    };
    registerHandler(process, "SIGINT", devShutdown);
    registerHandler(process, "SIGTERM", devShutdown);
  }

  const server = app.listen(selectedPort);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      server.listen(0);
    } else {
      console.error(`Failed to start server: ${err.message}`);
      process.exit(1);
    }
  });

  server.on("listening", () => {
    const actualPort = (server.address() as AddressInfo).port;

    if (actualPort !== selectedPort) {
      console.log(`⚠ Port ${selectedPort} in use, using ${actualPort} instead`);
    }

    console.log();
    console.log(`  fn board`);
    console.log(`  ────────────────────────`);
    console.log(`  → http://localhost:${actualPort}`);
    console.log();
    console.log(`  Tasks stored in .fusion/tasks/`);
    console.log(`  Merge:      AI-assisted (conflict resolution + commit messages)`);
    if (opts.dev) {
      console.log(`  AI engine:  ✗ disabled (dev mode)`);
    } else {
      console.log(`  AI engine:  ✓ active`);
      console.log(`    • triage: auto-specifying tasks`);
      console.log(`    • scheduler: dependency-aware execution`);
      console.log(`    • cron: scheduled task execution`);
    }
    console.log(`  File watcher: ✓ active`);
    console.log(`  Press Ctrl+C to stop`);
    console.log();
  });

  return { dispose };
}
