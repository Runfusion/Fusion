import { exec } from "node:child_process";
import { TaskStore } from "@hai/core";
import { createServer } from "@hai/dashboard";
import { TriageProcessor, TaskExecutor, Scheduler, aiMergeTask } from "@hai/engine";

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

  // AI-powered merge handler (used by the web UI for manual merges)
  const onMerge = (taskId: string) =>
    aiMergeTask(store, cwd, taskId, {
      onAgentText: (delta) => process.stdout.write(delta),
      onAgentTool: (name) => console.log(`[merger] tool: ${name}`),
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
          // Re-check autoMerge before each merge (setting may have been toggled)
          const settings = await store.getSettings();
          if (!settings.autoMerge) {
            console.log(`[auto-merge] Skipping ${taskId} — autoMerge disabled`);
            continue;
          }
          // Verify the task is still in-review (it may have been manually moved)
          const task = await store.getTask(taskId);
          if (task.column !== "in-review") {
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
    try {
      const settings = await store.getSettings();
      if (!settings.autoMerge) return;
      enqueueMerge(task.id);
    } catch { /* ignore settings read errors */ }
  });

  // Start the web server with AI merge wired in
  const app = createServer(store, { onMerge });

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
      onSpecifyStart: (t) => console.log(`[engine] Specifying ${t.id}...`),
      onSpecifyComplete: (t) => console.log(`[engine] ✓ ${t.id} → todo`),
      onSpecifyError: (t, e) => console.log(`[engine] ✗ ${t.id}: ${e.message}`),
    });

    const executor = new TaskExecutor(store, cwd, {
      onStart: (t, p) => console.log(`[engine] Executing ${t.id} in ${p}`),
      onComplete: (t) => console.log(`[engine] ✓ ${t.id} → in-review`),
      onError: (t, e) => console.log(`[engine] ✗ ${t.id}: ${e.message}`),
    });

    const settings = await store.getSettings();

    const scheduler = new Scheduler(store, {
      maxConcurrent: settings.maxConcurrent,
      maxWorktrees: settings.maxWorktrees,
      onSchedule: (t) => console.log(`[engine] Scheduled ${t.id}`),
      onBlocked: (t, deps) => console.log(`[engine] ${t.id} blocked by ${deps.join(", ")}`),
    });

    triage.start();
    scheduler.start();

    // ── Startup sweep: enqueue any tasks already in "in-review" ───────
    if (settings.autoMerge) {
      const existing = await store.listTasks();
      const inReview = existing.filter((t) => t.column === "in-review");
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
    // Uses the same interval as the scheduler so failed merges are
    // retried at a predictable cadence without adding extra timers.
    const mergeRetryInterval = setInterval(async () => {
      try {
        const currentSettings = await store.getSettings();
        if (!currentSettings.autoMerge) return;
        const tasks = await store.listTasks();
        for (const t of tasks) {
          if (t.column === "in-review") {
            enqueueMerge(t.id);
          }
        }
      } catch { /* ignore errors in periodic sweep */ }
    }, settings.pollIntervalMs ?? 15_000);

    process.on("SIGINT", () => {
      triage.stop();
      scheduler.stop();
      clearInterval(mergeRetryInterval);
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
