import type { AddressInfo } from "node:net";
import {
  TaskStore,
  AutomationStore,
  CentralCore,
  AgentStore,
  getTaskMergeBlocker,
} from "@fusion/core";
import { createServer, GitHubClient } from "@fusion/dashboard";
import {
  TriageProcessor,
  TaskExecutor,
  Scheduler,
  AgentSemaphore,
  WorktreePool,
  aiMergeTask,
  UsageLimitPauser,
  PRIORITY_MERGE,
  scanIdleWorktrees,
  cleanupOrphanedWorktrees,
  NtfyNotifier,
  PrMonitor,
  PrCommentHandler,
  CronRunner,
  StuckTaskDetector,
  SelfHealingManager,
  MissionAutopilot,
  createAiPromptExecutor,
} from "@fusion/engine";
import {
  AuthStorage,
  DefaultPackageManager,
  ModelRegistry,
  SettingsManager,
  discoverAndLoadExtensions,
  getAgentDir,
  createExtensionRuntime,
} from "@mariozechner/pi-coding-agent";
import {
  promptForPort,
  getMergeStrategy,
  processPullRequestMergeTask,
} from "./dashboard.js";

export async function runServe(
  port: number,
  opts: { interactive?: boolean; paused?: boolean; host?: string } = {},
) {
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

  const selectedHost = opts.host ?? "0.0.0.0";
  const cwd = process.cwd();

  const store = new TaskStore(cwd);
  await store.init();
  await store.watch();

  const automationStore = new AutomationStore(cwd);
  await automationStore.init();

  const agentStore = new AgentStore({ rootDir: store.getFusionDir() });
  await agentStore.init();

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

  if (opts.paused) {
    await store.updateSettings({ enginePaused: true });
    console.log("[engine] Starting in paused mode — automation disabled");
  }

  const initialSettings = await store.getSettings();
  let cachedMaxConcurrent = initialSettings.maxConcurrent;
  const semaphore = new AgentSemaphore(() => cachedMaxConcurrent);

  const pool = new WorktreePool();

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

  const usageLimitPauser = new UsageLimitPauser(store);
  const githubClient = new GitHubClient(process.env.GITHUB_TOKEN);

  let activeMergeSession: { dispose: () => void } | null = null;

  const rawMerge = (taskId: string) =>
    aiMergeTask(store, cwd, taskId, {
      pool,
      usageLimitPauser,
      agentStore,
      onAgentText: (delta) => process.stdout.write(delta),
      onSession: (session) => {
        activeMergeSession = session;
      },
    });

  const onMerge = (taskId: string) =>
    semaphore.run(() => rawMerge(taskId), PRIORITY_MERGE);

  store.on("settings:updated", ({ settings, previous }) => {
    if (settings.globalPause && !previous.globalPause) {
      if (activeMergeSession) {
        console.log("[auto-merge] Global pause — terminating active merge session");
        activeMergeSession.dispose();
        activeMergeSession = null;
      }
    }
  });

  const mergeQueue: string[] = [];
  const mergeActive = new Set<string>();
  let mergeRunning = false;

  function enqueueMerge(taskId: string): void {
    if (mergeActive.has(taskId)) return;
    mergeActive.add(taskId);
    mergeQueue.push(taskId);
    void drainMergeQueue();
  }

  async function drainMergeQueue(): Promise<void> {
    if (mergeRunning) return;
    mergeRunning = true;
    try {
      while (mergeQueue.length > 0) {
        const taskId = mergeQueue.shift()!;
        try {
          const settings = await store.getSettings();
          if (settings.globalPause || settings.enginePaused) {
            console.log(
              `[auto-merge] Skipping ${taskId} — ${settings.globalPause ? "global pause" : "engine paused"} active`,
            );
            continue;
          }
          if (!settings.autoMerge) {
            console.log(`[auto-merge] Skipping ${taskId} — autoMerge disabled`);
            continue;
          }

          const task = await store.getTask(taskId);
          if (getTaskMergeBlocker(task)) {
            continue;
          }

          const mergeStrategy = getMergeStrategy(settings);
          if (mergeStrategy === "pull-request") {
            console.log(`[auto-merge] Processing PR flow for ${taskId}...`);
            const result = await processPullRequestMergeTask(store, cwd, taskId, githubClient);
            if (result === "merged") {
              console.log(`[auto-merge] ✓ ${taskId} merged via pull request`);
            } else if (result === "waiting") {
              console.log(`[auto-merge] … ${taskId} waiting on PR checks or reviews`);
            }
          } else {
            console.log(`[auto-merge] Merging ${taskId}...`);
            await onMerge(taskId);
            console.log(`[auto-merge] ✓ ${taskId} merged`);
            if (task.mergeRetries && task.mergeRetries > 0) {
              await store.updateTask(taskId, { mergeRetries: 0 });
            }
          }
        } catch (err: any) {
          const errorMsg = err.message ?? String(err);
          console.log(`[auto-merge] ✗ ${taskId}: ${errorMsg}`);

          const settings = await store
            .getSettings()
            .catch(() => ({ autoResolveConflicts: true, mergeStrategy: "direct" as const }));
          const task = await store.getTask(taskId).catch(() => null);
          const mergeStrategy = getMergeStrategy(settings);

          if (mergeStrategy === "direct") {
            const isConflictError =
              errorMsg.includes("conflict") || errorMsg.includes("Conflict");

            if (task && isConflictError) {
              const currentRetries = task.mergeRetries ?? 0;
              const maxRetries = 3;

              if (settings.autoResolveConflicts !== false && currentRetries < maxRetries) {
                const newRetryCount = currentRetries + 1;
                await store.updateTask(taskId, {
                  mergeRetries: newRetryCount,
                  status: null,
                });

                const delayMs = 5000 * Math.pow(2, currentRetries);
                console.log(
                  `[auto-merge] ↻ ${taskId}: retry ${newRetryCount}/${maxRetries} in ${delayMs / 1000}s`,
                );

                setTimeout(() => {
                  enqueueMerge(taskId);
                }, delayMs);
              } else {
                if (currentRetries >= maxRetries) {
                  console.log(
                    `[auto-merge] ⊘ ${taskId}: max retries (${maxRetries}) exceeded — manual resolution required`,
                  );
                } else {
                  console.log(
                    `[auto-merge] ⊘ ${taskId}: autoResolveConflicts disabled — manual resolution required`,
                  );
                }
                try {
                  await store.updateTask(taskId, { status: null });
                } catch {
                  // best-effort
                }
              }
            } else {
              try {
                await store.updateTask(taskId, { status: null });
              } catch {
                // best-effort
              }
            }
          } else {
            try {
              await store.updateTask(taskId, { status: null });
            } catch {
              // best-effort
            }
          }
        } finally {
          mergeActive.delete(taskId);
        }
      }
    } finally {
      mergeRunning = false;
    }
  }

  store.on("task:moved", async ({ task, to }) => {
    if (to !== "in-review") return;
    if (getTaskMergeBlocker(task)) return;
    try {
      const settings = await store.getSettings();
      if (settings.globalPause || settings.enginePaused) return;
      if (!settings.autoMerge) return;
      enqueueMerge(task.id);
    } catch {
      // ignore settings read errors
    }
  });

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  try {
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

    const extensionsResult = await discoverAndLoadExtensions(
      packageExtensionPaths,
      cwd,
      undefined,
    );

    for (const { path, error } of extensionsResult.errors) {
      console.log(`[extensions] Failed to load ${path}: ${error}`);
    }

    for (const {
      name,
      config,
      extensionPath,
    } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `[extensions] Failed to register provider from ${extensionPath}: ${message}`,
        );
      }
    }

    extensionsResult.runtime.pendingProviderRegistrations = [];
    modelRegistry.refresh();

    (async () => {
      try {
        const settings = await store.getSettings();
        if (settings.openrouterModelSync === false) return;
        const hasOrAuth = await authStorage.getApiKey("openrouter");
        const headers: Record<string, string> = {};
        if (hasOrAuth) headers["Authorization"] = `Bearer ${hasOrAuth}`;
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers,
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: Array<{
            id: string;
            name: string;
            context_length?: number;
            top_provider?: { max_completion_tokens?: number };
            pricing?: Record<string, string>;
            architecture?: {
              modality?: string;
              input_modalities?: string[];
            };
          }>;
        };
        const orModels = (json.data || []).map((m: any) => {
          const id = (m.id || "").toLowerCase();
          const name = (m.name || "").toLowerCase();
          const reasoning =
            id.includes(":thinking") ||
            id.includes("-r1") ||
            id.includes("/r1") ||
            id.includes("o1-") ||
            id.includes("o3-") ||
            id.includes("o4-") ||
            id.includes("reasoner") ||
            name.includes("thinking") ||
            name.includes("reasoner");
          const hasVision =
            m.architecture?.input_modalities?.includes("image") ??
            m.architecture?.modality?.includes("multimodal") ??
            false;
          function parseCost(v?: string) {
            const n = parseFloat(v || "0");
            return isNaN(n) ? 0 : n * 1_000_000;
          }
          return {
            id: m.id,
            name: m.name || m.id,
            reasoning,
            input: (hasVision ? ["text", "image"] : ["text"]) as (
              | "text"
              | "image"
            )[],
            cost: {
              input: parseCost(m.pricing?.prompt),
              output: parseCost(m.pricing?.completion),
              cacheRead: parseCost(m.pricing?.input_cache_read),
              cacheWrite: parseCost(m.pricing?.input_cache_write),
            },
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
        console.log(
          `[openrouter] Synced ${orModels.length} models from OpenRouter API`,
        );
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

  const missionAutopilot = new MissionAutopilot(store, store.getMissionStore());

  const app = createServer(store, {
    onMerge,
    authStorage,
    modelRegistry,
    automationStore,
    missionAutopilot,
    headless: true,
  });

  const executorRef: { current: TaskExecutor | null } = { current: null };
  const triageRef: { current: TriageProcessor | null } = { current: null };

  const selfHealing = new SelfHealingManager(store, {
    rootDir: cwd,
    recoverCompletedTask: (task) =>
      executorRef.current?.recoverCompletedTask(task) ?? Promise.resolve(false),
    getExecutingTaskIds: () => executorRef.current?.getExecutingTaskIds() ?? new Set(),
  });
  const stuckTaskDetector = new StuckTaskDetector(store, {
    beforeRequeue: (taskId) => selfHealing.checkStuckBudget(taskId),
    onLoopDetected: (event) =>
      executorRef.current?.handleLoopDetected(event) ?? Promise.resolve(false),
    onStuck: (event) => {
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

  const scheduler = new Scheduler(store, {
    semaphore,
    prMonitor,
    missionStore: store.getMissionStore(),
    missionAutopilot,
    onSchedule: (t) => console.log(`[engine] Scheduled ${t.id}`),
    onBlocked: (t, deps) =>
      console.log(`[engine] ${t.id} blocked by ${deps.join(", ")}`),
    onClosedPrFeedback: async (taskId, prInfo, comments) => {
      await prCommentHandler.createFollowUpTask(taskId, prInfo, comments);
    },
  });

  missionAutopilot.setScheduler(scheduler);

  const aiPromptExecutor = await createAiPromptExecutor(cwd);
  const cronRunner = new CronRunner(store, automationStore, { aiPromptExecutor });
  cronRunner.start();

  triage.start();
  scheduler.start();
  missionAutopilot.start();
  stuckTaskDetector.start();
  selfHealing.start();

  executor.resumeOrphaned().catch((err) =>
    console.error("[engine] Failed to resume orphaned tasks:", err),
  );

  if (settings.autoMerge) {
    const existing = await store.listTasks();
    const inReview = existing.filter((t) => !getTaskMergeBlocker(t));
    if (inReview.length > 0) {
      console.log(
        `[auto-merge] Startup sweep: enqueueing ${inReview.length} in-review task(s)`,
      );
      for (const t of inReview) {
        enqueueMerge(t.id);
      }
    }
  }

  store.on("settings:updated", async ({ settings: s, previous: prev }) => {
    if (prev.globalPause && !s.globalPause) {
      console.log("[engine] Global unpause — resuming agentic activity");
      cachedMaxConcurrent = s.maxConcurrent ?? cachedMaxConcurrent;

      executor.resumeOrphaned().catch((err) =>
        console.error("[engine] Failed to resume orphaned tasks on unpause:", err),
      );

      if (s.autoMerge) {
        try {
          const tasks = await store.listTasks();
          for (const t of tasks) {
            if (!getTaskMergeBlocker(t)) {
              enqueueMerge(t.id);
            }
          }
        } catch {
          // ignore errors in unpause sweep
        }
      }
    }
  });

  store.on("settings:updated", async ({ settings: s, previous: prev }) => {
    if (prev.enginePaused && !s.enginePaused) {
      console.log("[engine] Engine unpaused — resuming agentic activity");
      cachedMaxConcurrent = s.maxConcurrent ?? cachedMaxConcurrent;

      executor.resumeOrphaned().catch((err) =>
        console.error(
          "[engine] Failed to resume orphaned tasks on engine unpause:",
          err,
        ),
      );

      if (s.autoMerge) {
        try {
          const tasks = await store.listTasks();
          for (const t of tasks) {
            if (!getTaskMergeBlocker(t)) {
              enqueueMerge(t.id);
            }
          }
        } catch {
          // ignore errors in unpause sweep
        }
      }
    }
  });

  store.on("settings:updated", async ({ settings: s, previous: prev }) => {
    if (s.taskStuckTimeoutMs !== prev.taskStuckTimeoutMs) {
      console.log(
        `[stuck-detector] Timeout changed to ${s.taskStuckTimeoutMs}ms — running immediate check`,
      );
      await stuckTaskDetector.checkNow();
    }
  });

  let mergeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  async function scheduleMergeRetry(): Promise<void> {
    const currentSettings = await store.getSettings().catch(() => settings);
    const interval = currentSettings.pollIntervalMs ?? 15_000;
    mergeRetryTimer = setTimeout(async () => {
      try {
        const s = await store.getSettings();
        cachedMaxConcurrent = s.maxConcurrent;
        if (!s.globalPause && !s.enginePaused && s.autoMerge) {
          const tasks = await store.listTasks();
          for (const t of tasks) {
            if (!getTaskMergeBlocker(t)) {
              enqueueMerge(t.id);
            }
          }
        }
      } catch {
        // ignore errors in periodic sweep
      }
      void scheduleMergeRetry();
    }, interval);
  }
  void scheduleMergeRetry();

  const server = app.listen(selectedPort, selectedHost);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const actualPort = (server.address() as AddressInfo).port;

  let centralCore: CentralCore | null = null;
  let localNodeId: string | undefined;

  try {
    centralCore = new CentralCore();
    await centralCore.init();
    const nodes = await centralCore.listNodes();
    const localNode = nodes.find((node) => node.type === "local");
    if (localNode) {
      localNodeId = localNode.id;
      await centralCore.updateNode(localNode.id, { status: "online" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[serve] Failed to set local node online: ${message}`);
  }

  console.log();
  console.log(`  Fusion Node`);
  console.log(`  ────────────────────────`);
  console.log(`  → http://${selectedHost}:${actualPort}`);
  console.log();
  console.log(`  Health:     GET /api/health`);
  console.log(`  API:        /api/*`);
  console.log(`  AI engine:  ✓ active`);
  console.log(`  Press Ctrl+C to stop`);
  console.log();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    selfHealing.stop();
    stuckTaskDetector.stop();
    missionAutopilot.stop();
    triage.stop();
    scheduler.stop();
    cronRunner.stop();
    notifier.stop();

    if (mergeRetryTimer) {
      clearTimeout(mergeRetryTimer);
      mergeRetryTimer = null;
    }

    if (centralCore && localNodeId) {
      try {
        await centralCore.updateNode(localNodeId, { status: "offline" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[serve] Failed to set local node offline: ${message}`);
      }
    }

    if (centralCore) {
      await centralCore.close().catch(() => {
        // best-effort
      });
      centralCore = null;
    }

    try {
      server.close();
    } catch {
      // best-effort
    }

    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}
