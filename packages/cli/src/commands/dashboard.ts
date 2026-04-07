import { execSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { TaskStore, AutomationStore, CentralCore, AgentStore, getTaskMergeBlocker } from "@fusion/core";
import type { Settings, TaskDetail, PrInfo } from "@fusion/core";
import { createServer, GitHubClient } from "@fusion/dashboard";
import { TriageProcessor, TaskExecutor, Scheduler, AgentSemaphore, WorktreePool, aiMergeTask, UsageLimitPauser, PRIORITY_MERGE, scanIdleWorktrees, cleanupOrphanedWorktrees, NtfyNotifier, PrMonitor, PrCommentHandler, CronRunner, StuckTaskDetector, SelfHealingManager, MissionAutopilot, createAiPromptExecutor } from "@fusion/engine";
import { AuthStorage, DefaultPackageManager, ModelRegistry, SettingsManager, discoverAndLoadExtensions, getAgentDir, createExtensionRuntime } from "@mariozechner/pi-coding-agent";

/**
 * Prompt the user for a port number interactively.
 * Shows "Port [4040]: " and accepts user input or Enter for default.
 * Validates input is a valid port number (1-65535).
 * Re-prompts on invalid input.
 * Handles SIGINT (Ctrl+C) gracefully.
 */
export function promptForPort(defaultPort: number = 4040, input: NodeJS.ReadableStream = process.stdin): Promise<number> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input,
      output: process.stdout,
    });

    // Handle Ctrl+C during prompt
    const sigintHandler = () => {
      rl.close();
      console.log("\n");
      reject(new Error("Interactive prompt cancelled"));
    };
    process.on("SIGINT", sigintHandler);

    const ask = () => {
      rl.question(`Port [${defaultPort}]: `, (answer) => {
        const trimmed = answer.trim();

        // Empty input: use default
        if (trimmed === "") {
          process.removeListener("SIGINT", sigintHandler);
          rl.close();
          resolve(defaultPort);
          return;
        }

        // Validate as number
        const port = parseInt(trimmed, 10);
        if (isNaN(port)) {
          console.log(`Invalid input: "${trimmed}" is not a number`);
          ask();
          return;
        }

        // Validate port range
        if (port < 1 || port > 65535) {
          console.log(`Invalid port: ${port} (must be between 1 and 65535)`);
          ask();
          return;
        }

        process.removeListener("SIGINT", sigintHandler);
        rl.close();
        resolve(port);
      });
    };

    ask();
  });
}

export function getMergeStrategy(settings: Pick<Settings, "mergeStrategy">): NonNullable<Settings["mergeStrategy"]> {
  return settings.mergeStrategy ?? "direct";
}

export function getTaskBranchName(taskId: string): string {
  return `fusion/${taskId.toLowerCase()}`;
}

function buildPullRequestTitle(task: Pick<TaskDetail, "id" | "title">): string {
  return task.title ? `${task.id}: ${task.title}` : task.id;
}

function buildPullRequestBody(task: Pick<TaskDetail, "id" | "description">): string {
  return [`Automated PR for ${task.id}.`, "", task.description].join("\n");
}

function cleanupMergedTaskArtifacts(cwd: string, task: Pick<TaskDetail, "id" | "worktree">): void {
  const branch = getTaskBranchName(task.id);

  if (task.worktree) {
    try {
      execSync(`git worktree remove \"${task.worktree}\" --force`, {
        cwd,
        stdio: "pipe",
      });
    } catch {
      // Best-effort cleanup — worktree may already be gone.
    }
  }

  try {
    execSync(`git branch -d \"${branch}\"`, {
      cwd,
      stdio: "pipe",
    });
  } catch {
    try {
      execSync(`git branch -D \"${branch}\"`, {
        cwd,
        stdio: "pipe",
      });
    } catch {
      // Best-effort cleanup — branch may already be gone.
    }
  }
}

export async function processPullRequestMergeTask(
  store: TaskStore,
  cwd: string,
  taskId: string,
  github: Pick<GitHubClient, "findPrForBranch" | "createPr" | "getPrMergeStatus" | "mergePr">,
): Promise<"waiting" | "merged" | "skipped"> {
  const task = await store.getTask(taskId);
  if (getTaskMergeBlocker(task)) {
    return "skipped";
  }

  const branch = getTaskBranchName(task.id);
  let prInfo: PrInfo | undefined = task.prInfo;

  if (!prInfo) {
    await store.updateTask(task.id, { status: "creating-pr" });

    const existingPr = await github.findPrForBranch({ head: branch, state: "all" });
    prInfo = existingPr ?? await github.createPr({
      title: buildPullRequestTitle(task),
      body: buildPullRequestBody(task),
      head: branch,
    });

    await store.updatePrInfo(task.id, prInfo);
    await store.logEntry(
      task.id,
      existingPr ? "Linked existing PR" : "Created PR",
      `PR #${prInfo.number}: ${prInfo.url}`,
    );
  }

  if (!prInfo) {
    throw new Error(`Failed to create or resolve pull request for ${task.id}`);
  }

  const mergeStatus = await github.getPrMergeStatus(undefined, undefined, prInfo.number);
  const refreshedPrInfo: PrInfo = {
    ...prInfo,
    ...mergeStatus.prInfo,
    lastCheckedAt: new Date().toISOString(),
  };
  await store.updatePrInfo(task.id, refreshedPrInfo);

  if (mergeStatus.prInfo.status === "merged") {
    cleanupMergedTaskArtifacts(cwd, task);
    await store.moveTask(task.id, "done");
    await store.updateTask(task.id, { status: null, mergeRetries: 0 });
    await store.logEntry(task.id, "Pull request merged", `PR #${prInfo.number}: ${prInfo.url}`);
    return "merged";
  }

  if (!mergeStatus.mergeReady) {
    if (mergeStatus.prInfo.status === "open") {
      await store.updateTask(task.id, { status: "awaiting-pr-checks" });
    } else {
      await store.updateTask(task.id, { status: null });
    }
    return "waiting";
  }

  await store.updateTask(task.id, { status: "merging-pr" });
  const mergedPr = await github.mergePr({ number: prInfo.number, method: "squash" });
  await store.updatePrInfo(task.id, { ...mergedPr, lastCheckedAt: new Date().toISOString() });
  cleanupMergedTaskArtifacts(cwd, task);
  await store.moveTask(task.id, "done");
  await store.updateTask(task.id, { status: null, mergeRetries: 0 });
  await store.logEntry(task.id, "Pull request merged", `PR #${mergedPr.number}: ${mergedPr.url}`);
  return "merged";
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

  // ── Shared concurrency semaphore ──────────────────────────────────
  //
  // Gates all agentic activities (triage, execution, merge) behind a
  // single slot limit so they collectively respect settings.maxConcurrent.
  // Created eagerly so the merge queue can reference it; the engine block
  // below passes it to triage/executor/scheduler as well.
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
  const githubClient = new GitHubClient(process.env.GITHUB_TOKEN);

  // AI-powered merge handler (used by the web UI for manual merges).
  // Wrapped with the shared semaphore so merges count toward the global
  // concurrency limit alongside triage and execution agents.
  //
  // Track the active merge session so it can be killed on global pause.
  let activeMergeSession: { dispose: () => void } | null = null;

  const rawMerge = (taskId: string) =>
    aiMergeTask(store, cwd, taskId, {
      pool,
      usageLimitPauser,
      onAgentText: (delta) => process.stdout.write(delta),
      onSession: (session) => { activeMergeSession = session; },
    });

  const onMerge = (taskId: string) => semaphore.run(() => rawMerge(taskId), PRIORITY_MERGE);

  // When globalPause transitions from false → true, terminate the active merge session.
  store.on("settings:updated", ({ settings, previous }) => {
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
              const maxRetries = 3;

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
              // Non-conflict error - reset task status
              try {
                await store.updateTask(taskId, { status: null });
              } catch { /* best-effort */ }
            }
          } else {
            try {
              await store.updateTask(taskId, { status: null });
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
  store.on("task:moved", async ({ task, to }) => {
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

  // Start the web server with AI merge, auth, and model registry wired in
  const app = createServer(store, { onMerge, authStorage, modelRegistry, automationStore, missionAutopilot });

  // Start the AI engine (unless in dev mode)
  if (!opts.dev) {
    const triage = new TriageProcessor(store, cwd, {
      semaphore,
      usageLimitPauser,
      onSpecifyStart: (t) => console.log(`[engine] Specifying ${t.id}...`),
      onSpecifyComplete: (t) => console.log(`[engine] ✓ ${t.id} → todo`),
      onSpecifyError: (t, e) => console.log(`[engine] ✗ ${t.id}: ${e.message}`),
    });

    // ── Self-healing: auto-unpause, stuck kill budgets, maintenance ─────
    const selfHealing = new SelfHealingManager(store, {
      rootDir: cwd,
      recoverCompletedTask: (task) => executorRef.current?.recoverCompletedTask(task) ?? Promise.resolve(false),
      getExecutingTaskIds: () => executorRef.current?.getExecutingTaskIds() ?? new Set(),
    });

    // ── Stuck task detector: monitors agent sessions for stagnation ────
    // Created before the executor so it can be passed in options.
    // The onStuck callback is wired to executor.markStuckAborted after
    // executor creation (late-binding via closure on executorRef).
    const executorRef: { current: TaskExecutor | null } = { current: null };
    const stuckTaskDetector = new StuckTaskDetector(store, {
      beforeRequeue: (taskId) => selfHealing.checkStuckBudget(taskId),
      onLoopDetected: (event) => executorRef.current?.handleLoopDetected(event) ?? Promise.resolve(false),
      onStuck: (event) => {
        executorRef.current?.markStuckAborted(event.taskId, event.shouldRequeue);
        console.log(
          `[engine] ⚠ ${event.taskId} stuck (${event.reason}) — ` +
          `no progress for ${Math.round(event.noProgressMs / 60_000)}min, ` +
          `${event.activitySinceProgress} events since last progress — ` +
          `terminated, ${event.shouldRequeue ? "will retry" : "budget exhausted"}`,
        );
      },
    });

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
    const aiPromptExecutor = await createAiPromptExecutor(cwd);
    const cronRunner = new CronRunner(store, automationStore, { aiPromptExecutor });
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

    // ── Immediate unpause: resume orphans + merge sweep ─────────────
    // When globalPause transitions from true → false, immediately:
    // 1. Refresh cachedMaxConcurrent so the semaphore picks up live changes
    // 2. Resume orphaned in-progress tasks whose agents were killed by pause
    // 3. Sweep the merge queue for in-review tasks that need merging
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
          } catch { /* ignore errors in unpause sweep */ }
        }
      }
    });

    // ── Immediate engine-unpause: resume orphans + merge sweep ────────
    // When enginePaused transitions from true → false, same resume logic
    // as globalPause unpause: pick up orphaned tasks and sweep merge queue.
    store.on("settings:updated", async ({ settings: s, previous: prev }) => {
      if (prev.enginePaused && !s.enginePaused) {
        console.log("[engine] Engine unpaused — resuming agentic activity");
        cachedMaxConcurrent = s.maxConcurrent ?? cachedMaxConcurrent;

        executor.resumeOrphaned().catch((err) =>
          console.error("[engine] Failed to resume orphaned tasks on engine unpause:", err),
        );

        if (s.autoMerge) {
          try {
            const tasks = await store.listTasks();
            for (const t of tasks) {
              if (!getTaskMergeBlocker(t)) {
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
    store.on("settings:updated", async ({ settings: s, previous: prev }) => {
      if (s.taskStuckTimeoutMs !== prev.taskStuckTimeoutMs) {
        console.log(`[stuck-detector] Timeout changed to ${s.taskStuckTimeoutMs}ms — running immediate check`);
        await stuckTaskDetector.checkNow();
      }
    });

    // ── Periodic retry: catch failed merges on each poll cycle ────────
    // Uses a setTimeout chain so the interval dynamically follows
    // settings.pollIntervalMs without requiring an engine restart.
    let mergeRetryTimer: ReturnType<typeof setTimeout> | null = null;
    async function scheduleMergeRetry(): Promise<void> {
      const currentSettings = await store.getSettings().catch(() => settings);
      const interval = currentSettings.pollIntervalMs ?? 15_000;
      mergeRetryTimer = setTimeout(async () => {
        try {
          const s = await store.getSettings();
          // Refresh the cached limit so the semaphore picks up live changes
          cachedMaxConcurrent = s.maxConcurrent;
          if (!s.globalPause && !s.enginePaused && s.autoMerge) {
            const tasks = await store.listTasks();
            for (const t of tasks) {
              if (!getTaskMergeBlocker(t)) {
                enqueueMerge(t.id);
              }
            }
          }
        } catch { /* ignore errors in periodic sweep */ }
        scheduleMergeRetry();
      }, interval);
    }
    // Kick off the first retry after the current poll interval
    scheduleMergeRetry();

    const shutdown = () => {
      selfHealing.stop();
      stuckTaskDetector.stop();
      missionAutopilot.stop();
      triage.stop();
      scheduler.stop();
      cronRunner.stop();
      notifier.stop();
      if (mergeRetryTimer) clearTimeout(mergeRetryTimer);
      store.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  // Dev mode: simplified shutdown handlers (no engine components)
  if (opts.dev) {
    const devShutdown = () => {
      notifier.stop();
      store.close();
      process.exit(0);
    };
    process.on("SIGINT", devShutdown);
    process.on("SIGTERM", devShutdown);
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
    console.log(`  kb board`);
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
}
