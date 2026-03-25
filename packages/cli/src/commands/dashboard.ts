import { exec } from "child_process";
import { TaskStore } from "@hai/core";
import { createServer } from "@hai/dashboard";
import { TriageProcessor, TaskExecutor, Scheduler } from "@hai/engine";

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd, () => {});
  } catch {
    // Silently ignore — e.g., headless environments
  }
}

export async function runDashboard(port: number, opts: { engine?: boolean; open?: boolean } = {}) {
  const cwd = process.cwd();
  const store = new TaskStore(cwd);
  await store.init();

  // Start the web server
  const app = createServer(store);

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

    const scheduler = new Scheduler(store, {
      maxConcurrent: 2,
      onSchedule: (t) => console.log(`[engine] Scheduled ${t.id}`),
      onBlocked: (t, deps) => console.log(`[engine] ${t.id} blocked by ${deps.join(", ")}`),
    });

    triage.start();
    scheduler.start();

    process.on("SIGINT", () => {
      triage.stop();
      scheduler.stop();
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
    if (opts.engine) {
      console.log(`  AI engine:  ✓ active`);
      console.log(`    • triage: auto-specifying tasks`);
      console.log(`    • scheduler: dependency-aware execution`);
    } else {
      console.log(`  AI engine:  off (use --engine to enable)`);
    }
    console.log(`  Press Ctrl+C to stop`);
    console.log();

    if (opts.open !== false) {
      openBrowser(`http://localhost:${port}`);
    }
  });
}
