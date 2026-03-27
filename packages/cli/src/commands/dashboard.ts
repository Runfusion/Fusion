import { exec } from "node:child_process";
import { TaskStore } from "@hai/core";
import { createServer } from "@hai/dashboard";
import { TriageProcessor, TaskExecutor, Scheduler, AgentSemaphore, WorktreePool, aiMergeTask } from "@hai/engine";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

export async function runDashboard(port: number, opts: { engine?: boolean; open?: boolean } = {}) {
  const cwd = process.cwd();
  const store = new TaskStore(cwd);
  await store.init();
  await store.watch();

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

  // AI-powered merge handler (used by the web UI for manual merges).
  // Wrapped with the shared semaphore so merges count toward the global
  // concurrency limit alongside triage and execution agents.
  const rawMerge = (taskId: string) =>
    aiMergeTask(store, cwd, taskId, {
      pool,
      onAgentText: (delta) => process.stdout.write(delta),
      onAgentTool: (name) => console.log(`[merger] tool: ${name}`),
    });

  const onMerge = (taskId: string) => semaphore.run(() => rawMerge(taskId));

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
          // Re-check autoMerge before each merge (setting may have been toggled)
          const settings = await store.getSettings();
          if (!settings.autoMerge) {
            console.log(`[auto-merge] Skipping ${taskId} — autoMerge disabled`);
            continue;
          }
          // Verify the task is still in-review and not paused
          const task = await store.getTask(taskId);
          if (task.column !== "in-review" || task.paused) {
            continue;
          }
          console.log(`[auto-merge] Merging ${taskId}...`);
          await onMerge(taskId);
          console.log(`[auto-merge] ✓ ${taskId} merged`);
        } catch (err: any) {
          console.log(`[auto-merge] ✗ ${taskId}: ${err.message ?? err}`);
          // Reset task status so it doesn't appear stuck as "merging" in the UI
          try {
            await store.updateTask(taskId, { status: null });
          } catch { /* best-effort */ }
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
    if (task.paused) return;
    try {
      const settings = await store.getSettings();
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

  // Start the web server with AI merge, auth, and model registry wired in
  const app = createServer(store, { onMerge, authStorage, modelRegistry });

  // Clean shutdown for file watcher when engine is not active
  if (!opts.engine) {
    process.on("SIGINT", () => {
      store.stopWatching();
      process.exit(0);
    });
  }

  // Optionally start the AI engine
  if (opts.engine) {
    const triage = new TriageProcessor(store, cwd, {
      semaphore,
      onSpecifyStart: (t) => console.log(`[engine] Specifying ${t.id}...`),
      onSpecifyComplete: (t) => console.log(`[engine] ✓ ${t.id} → todo`),
      onSpecifyError: (t, e) => console.log(`[engine] ✗ ${t.id}: ${e.message}`),
    });

    const executor = new TaskExecutor(store, cwd, {
      semaphore,
      pool,
      onStart: (t, p) => console.log(`[engine] Executing ${t.id} in ${p}`),
      onComplete: (t) => console.log(`[engine] ✓ ${t.id} → in-review`),
      onError: (t, e) => console.log(`[engine] ✗ ${t.id}: ${e.message}`),
    });

    const settings = await store.getSettings();

    const scheduler = new Scheduler(store, {
      semaphore,
      onSchedule: (t) => console.log(`[engine] Scheduled ${t.id}`),
      onBlocked: (t, deps) => console.log(`[engine] ${t.id} blocked by ${deps.join(", ")}`),
    });

    triage.start();
    scheduler.start();

    // ── Startup sweep: resume orphaned in-progress tasks ──────────────
    executor.resumeOrphaned().catch((err) =>
      console.error("[engine] Failed to resume orphaned tasks:", err),
    );

    // ── Startup sweep: enqueue any tasks already in "in-review" ───────
    if (settings.autoMerge) {
      const existing = await store.listTasks();
      const inReview = existing.filter((t) => t.column === "in-review" && !t.paused);
      if (inReview.length > 0) {
        console.log(
          `[auto-merge] Startup sweep: enqueueing ${inReview.length} in-review task(s)`,
        );
        for (const t of inReview) {
          enqueueMerge(t.id);
        }
      }
    }

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
          if (s.autoMerge) {
            const tasks = await store.listTasks();
            for (const t of tasks) {
              if (t.column === "in-review" && !t.paused) {
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

    process.on("SIGINT", () => {
      triage.stop();
      scheduler.stop();
      if (mergeRetryTimer) clearTimeout(mergeRetryTimer);
      store.stopWatching();
      process.exit(0);
    });
  }

  app.listen(port, () => {
    console.log();
    console.log(`  hai board`);
    console.log(`  ────────────────────────`);
    console.log(`  → http://localhost:${port}`);
    console.log();
    console.log(`  Tasks stored in .hai/tasks/`);
    console.log(`  Merge:      AI-assisted (conflict resolution + commit messages)`);
    if (opts.engine) {
      console.log(`  AI engine:  ✓ active`);
      console.log(`    • triage: auto-specifying tasks`);
      console.log(`    • scheduler: dependency-aware execution`);
    } else {
      console.log(`  AI engine:  off (use --engine to enable)`);
    }
    console.log(`  File watcher: ✓ active`);
    console.log(`  Press Ctrl+C to stop`);
    console.log();

    if (opts.open !== false) {
      openBrowser(`http://localhost:${port}`);
    }
  });
}
