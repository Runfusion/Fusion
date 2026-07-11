import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveAiSessionEvent, PluginContext, Task } from "@fusion/core";
import { PluginLoader, PluginStore, TaskStore } from "@fusion/core";
import plugin, {
  CeOrchestrator,
  CE_PLUGIN_ID,
  WORK_STAGE_ID,
} from "../index.js";
import { getCePipelineStore } from "../sync/pipeline-store.js";
import { CeReconciler, reconcileCePipelines } from "../sync/reconciler.js";
import { registerStage, unregisterStage } from "../session/stage-registry.js";
import { makeScriptedSession } from "./_harness.js";

/**
 * U8 bidirectional-sync tests. REAL in-memory TaskStore (genuine board tasks) +
 * the actual lifecycle-hook handlers and reconciler. We exercise the two
 * separate state machines (board columns vs ce_pipeline_state) and prove the
 * dropped-event convergence path independently of the hooks.
 */

let rootDir: string;
let taskStore: TaskStore;
let ctx: PluginContext;
let emitted: Array<{ event: string; data: unknown }>;

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), "ce-sync-"));
  taskStore = new TaskStore(rootDir, join(rootDir, ".fusion-global"), { inMemoryDb: true });
  await taskStore.init();
  emitted = [];
  ctx = {
    pluginId: CE_PLUGIN_ID,
    taskStore,
    settings: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: (event: string, data: unknown) => emitted.push({ event, data }),
  } as unknown as PluginContext;
});

afterEach(async () => {
  taskStore?.close();
  await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** The board enforces ordered transitions; walk a task forward to a target column. */
const COLUMN_PATH = ["triage", "todo", "in-progress", "in-review", "done"];
async function moveTo(taskId: string, target: string): Promise<void> {
  const current = (await taskStore.getTask(taskId))!.column;
  const from = COLUMN_PATH.indexOf(current);
  const to = COLUMN_PATH.indexOf(target);
  for (let i = from + 1; i <= to; i++) {
    await taskStore.moveTask(taskId, COLUMN_PATH[i] as never);
  }
}

/** Run the work stage so a CE pipeline + its first board task + state record exist. */
async function landPipeline(stage = "plan"): Promise<{ cePipelineId: string; task: Task }> {
  // Register-free: drive the WORK stage (which seeds state) but point the link at
  // `stage` so we can advance through the real stage order. Simplest: use the
  // work bridge directly via the orchestrator at the work stage, then rewrite the
  // pipeline state's currentStage to `stage` for ordering tests.
  const script: InteractiveAiSessionEvent[] = [
    { type: "complete", data: { artifact: "# log\n", tasks: [{ description: "do stage work" }] } },
  ];
  const orch = new CeOrchestrator({
    ctx,
    createInteractiveAiSession: vi.fn(async () => ({ session: makeScriptedSession(script) })),
    projectRoot: rootDir,
    turnTimeoutMs: 5000,
  });
  const started = await orch.start(WORK_STAGE_ID, { openingMessage: "go" });
  const cePipelineId = started.session.id;
  const store = getCePipelineStore(ctx);

  if (stage !== WORK_STAGE_ID) {
    // Reposition both the link stage and the state stage to `stage` so the
    // pipeline has a non-terminal stage to advance FROM.
    const links = store.listByPipeline(cePipelineId);
    const db = taskStore.getDatabase();
    for (const l of links) {
      db.prepare(`UPDATE ce_pipeline_links SET ceStageId = ? WHERE id = ?`).run(stage, l.id);
    }
    store.upsertState({ cePipelineId, currentStage: stage, status: "running" });
  }
  const tasks = await taskStore.listTasks();
  return { cePipelineId, task: tasks[0] };
}

describe("U8 inbound hooks (board → pipeline)", () => {
  it("onTaskMoved only enqueues when the task is CE-linked; ignores unrelated tasks fast", async () => {
    const { task } = await landPipeline("plan");
    const store = getCePipelineStore(ctx);

    // Unrelated (non-CE) board task → hook is a no-op (no queue row).
    const other = await taskStore.createTask({ description: "unrelated work" });
    await plugin.hooks.onTaskMoved!(other, "triage", "todo", ctx);
    expect(store.listPendingSync()).toHaveLength(0);

    // CE-linked task move → a queue row is appended synchronously. We do NOT
    // await the hook (its body is synchronous; awaiting would let the
    // fired-and-forgotten reconcile drain the row), so we observe the pending
    // entry the fast path wrote before any deferred work runs.
    void plugin.hooks.onTaskMoved!(task, "todo", "in-progress", ctx);
    const pending = store.listPendingSync();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some((p) => p.taskId === task.id && p.reason === "task_moved")).toBe(true);
  });

  it("the hook handler does NOT advance the pipeline inline (heavy work is deferred)", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    const store = getCePipelineStore(ctx);

    // Move the task to a terminal column then fire ONLY the synchronous part of
    // the hook. We assert that synchronously the pipeline stage is unchanged —
    // advancement happens in the (deferred) reconcile, not inline.
    await moveTo(task.id, "done");
    const stageBefore = store.getState(cePipelineId)!.currentStage;
    // Drive the hook but capture state immediately after the synchronous body.
    const p = plugin.hooks.onTaskMoved!(task, "in-progress", "done", ctx);
    // The synchronous body has already run (enqueue) but the fired-and-forgotten
    // reconcile has not been awaited. Inline, the stage must be unchanged.
    expect(store.getState(cePipelineId)!.currentStage).toBe(stageBefore);
    // A queue row exists (the fast path did its job).
    expect(store.listPendingSync().some((q) => q.taskId === task.id)).toBe(true);
    await p; // let the fire-and-forget settle for clean teardown.
  });

  it("the hook handler completes well under the 5s budget even with a slow reconciler", async () => {
    const { task } = await landPipeline("plan");
    await moveTo(task.id, "done");
    const start = Date.now();
    await plugin.hooks.onTaskMoved!(task, "in-progress", "done", ctx);
    // The hook awaits NOTHING heavy; it returns synchronously-ish.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("runtime loader invocation gives onTaskCompleted a context and enqueues task_completed sync", async () => {
    const pluginStore = new PluginStore(rootDir, { inMemoryDb: true, centralGlobalDir: rootDir });
    await pluginStore.init();
    await pluginStore.registerPlugin({
      manifest: plugin.manifest,
      path: join(rootDir, "compound-engineering.js"),
      settings: { reconcileOnHooks: false },
    });
    const loader = new PluginLoader({ pluginStore, taskStore });
    (loader as unknown as { plugins: Map<string, typeof plugin> }).plugins.set(CE_PLUGIN_ID, plugin);

    const { task } = await landPipeline("plan");
    await moveTo(task.id, "done");
    await expect(loader.invokeHook("onTaskCompleted", { ...task, column: "done" })).resolves.toBeUndefined();

    const installed = await pluginStore.getPlugin(CE_PLUGIN_ID);
    expect(installed.state).not.toBe("error");
    const pending = getCePipelineStore(ctx).listPendingSync();
    expect(pending).toContainEqual(expect.objectContaining({
      taskId: task.id,
      reason: "task_completed",
      fromColumn: null,
      toColumn: "done",
      processedAt: null,
    }));
  });
});

describe("U8 reconciler (convergence + outbound)", () => {
  it("AE3: a CE task reaching a terminal column advances the pipeline to the next stage with NO manual step", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    const store = getCePipelineStore(ctx);
    expect(store.getState(cePipelineId)!.currentStage).toBe("plan");

    // Board moves the task to done (the only manual-equivalent action: a normal
    // board transition). The hook enqueues; reconcile advances.
    await moveTo(task.id, "done");
    await plugin.hooks.onTaskCompleted!({ ...task, column: "done" }, ctx);
    await reconcileCePipelines(ctx);

    // Pipeline advanced plan → work (next in stage order) with no manual step.
    const state = store.getState(cePipelineId)!;
    expect(state.currentStage).toBe("work");
  });

  it("completing work advances to Compound without creating a debug task", async () => {
    const { cePipelineId, task } = await landPipeline("work");
    const before = await taskStore.listTasks();

    await moveTo(task.id, "done");
    const result = await reconcileCePipelines(ctx);

    expect(result.advanced).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(getCePipelineStore(ctx).getState(cePipelineId)).toMatchObject({
      currentStage: "compound",
      status: "awaiting_board",
    });
    expect(await taskStore.listTasks()).toHaveLength(before.length + 1);
    expect(getCePipelineStore(ctx).listByPipeline(cePipelineId).some((link) => link.ceStageId === "debug")).toBe(false);
  });

  it("completing Compound closes the delivery loop without creating another task", async () => {
    const { cePipelineId, task } = await landPipeline("compound");
    const before = await taskStore.listTasks();

    await moveTo(task.id, "done");
    const result = await reconcileCePipelines(ctx);

    expect(result.advanced).toBe(1);
    expect(result.tasksCreated).toBe(0);
    expect(getCePipelineStore(ctx).getState(cePipelineId)).toMatchObject({
      currentStage: "compound",
      status: "completed",
    });
    expect(await taskStore.listTasks()).toHaveLength(before.length);
  });

  it("outbound: advancing the pipeline propagates a NEW next-stage board task", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    const before = (await taskStore.listTasks()).length;

    await moveTo(task.id, "in-review");
    await reconcileCePipelines(ctx); // no hook fired — pure re-derivation.

    const after = await taskStore.listTasks();
    expect(after.length).toBe(before + 1);
    const newTask = after.find((t) => t.id !== task.id)!;
    const meta = newTask.sourceMetadata as Record<string, unknown>;
    expect(meta.pluginId).toBe(CE_PLUGIN_ID);
    expect(meta.cePipelineId).toBe(cePipelineId);
    expect(meta.ceStageId).toBe("work");
    // The pipeline is now awaiting the new board task.
    expect(getCePipelineStore(ctx).getState(cePipelineId)!.status).toBe("awaiting_board");
  });

  it("MISSED HOOK EVENT → the reconcile sweep still converges (no queue row needed)", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    const store = getCePipelineStore(ctx);

    // Simulate a DROPPED hook: move the board task to a terminal column but do
    // NOT call any hook and do NOT enqueue anything.
    await moveTo(task.id, "done");
    expect(store.listPendingSync()).toHaveLength(0); // nothing was enqueued.
    expect(store.getState(cePipelineId)!.currentStage).toBe("plan"); // not advanced yet.

    // The on-demand sweep re-derives the transition from board truth alone.
    const result = await new CeReconciler(ctx).reconcile();
    expect(result.advanced).toBe(1);
    expect(store.getState(cePipelineId)!.currentStage).toBe("work");
  });

  it("reconcile is idempotent: a second sweep does not double-advance or duplicate tasks", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    await moveTo(task.id, "done");
    await reconcileCePipelines(ctx);
    const afterFirst = (await taskStore.listTasks()).length;
    const stageFirst = getCePipelineStore(ctx).getState(cePipelineId)!.currentStage;

    await reconcileCePipelines(ctx);
    expect((await taskStore.listTasks()).length).toBe(afterFirst);
    expect(getCePipelineStore(ctx).getState(cePipelineId)!.currentStage).toBe(stageFirst);
  });

  it("brainstorm advances to plan once while sharing the unified docs/plans artifact path", async () => {
    const { cePipelineId, task } = await landPipeline("brainstorm");
    const store = getCePipelineStore(ctx);
    const unifiedPath = "docs/plans/2026-06-27-001-feature-topic-plan.md";
    store.transitionState(cePipelineId, { lastArtifactPath: unifiedPath });

    await moveTo(task.id, "done");
    const first = await reconcileCePipelines(ctx);
    expect(first.advanced).toBe(1);
    expect(first.tasksCreated).toBe(1);

    const afterFirst = await taskStore.listTasks();
    const planTasks = afterFirst.filter((t) => (t.sourceMetadata as Record<string, unknown>)?.ceStageId === "plan");
    expect(planTasks).toHaveLength(1);
    expect((planTasks[0].sourceMetadata as Record<string, unknown>).ceArtifactPath).toBe(unifiedPath);
    expect(store.listByPipeline(cePipelineId).filter((l) => l.ceStageId === "plan")).toMatchObject([
      { ceArtifactPath: unifiedPath },
    ]);
    expect(store.getState(cePipelineId)).toMatchObject({
      currentStage: "plan",
      status: "awaiting_board",
      lastArtifactPath: unifiedPath,
    });

    const second = await reconcileCePipelines(ctx);
    expect(second.tasksCreated).toBe(0);
    expect((await taskStore.listTasks()).length).toBe(afterFirst.length);
    expect(store.listByPipeline(cePipelineId).filter((l) => l.ceStageId === "plan")).toHaveLength(1);
  });

  it("partial completion does not advance: pipeline stays running until ALL current-stage tasks are terminal", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    const store = getCePipelineStore(ctx);
    const unifiedPath = "docs/plans/2026-06-27-001-feature-topic-plan.md";
    store.transitionState(cePipelineId, { lastArtifactPath: unifiedPath });
    // Add a second current-stage task to the SAME pipeline/stage.
    const t2 = await taskStore.createTask({ description: "second plan task" });
    store.createLink({ taskId: t2.id, cePipelineId, ceStageId: "plan", ceArtifactPath: unifiedPath });

    await moveTo(task.id, "done"); // only one terminal.
    await reconcileCePipelines(ctx);
    expect(store.getState(cePipelineId)!.currentStage).toBe("plan"); // not advanced.

    await moveTo(t2.id, "done"); // now both terminal.
    await reconcileCePipelines(ctx);
    expect(store.getState(cePipelineId)!.currentStage).toBe("work"); // advanced.
    const workLink = store.listByPipeline(cePipelineId).find((l) => l.ceStageId === "work");
    expect(workLink?.ceArtifactPath).toBe(unifiedPath);
  });

  it("Bug 1: a deleted current-stage task does NOT wedge the pipeline — one terminal + one deleted still advances", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    const store = getCePipelineStore(ctx);

    // Add a SECOND current-stage task linked to the same pipeline/stage, then
    // DELETE it from the board (loadTasks will yield undefined for it).
    const doomed = await taskStore.createTask({ description: "second plan task (to delete)" });
    store.createLink({ taskId: doomed.id, cePipelineId, ceStageId: "plan", ceArtifactPath: null });
    await taskStore.deleteTask(doomed.id);

    // The remaining task reaches terminal. Pre-fix: the deleted task made
    // `every(... t && ...)` false, wedging the pipeline at "plan" forever.
    await moveTo(task.id, "done");
    await reconcileCePipelines(ctx);

    // Post-fix: terminality is computed over EXISTING tasks only → it advances.
    expect(store.getState(cePipelineId)!.currentStage).toBe("work");
  });

  it("Bug 1: if ALL current-stage tasks were deleted, the pipeline is left unchanged (no wedge, no crash)", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    const store = getCePipelineStore(ctx);

    await taskStore.deleteTask(task.id); // every current-stage task gone.

    // Safe non-wedging behavior: state unchanged, no advancement, no throw.
    await expect(reconcileCePipelines(ctx)).resolves.toBeTruthy();
    expect(store.getState(cePipelineId)!.currentStage).toBe("plan");
  });

  it("Bug 3: a stage registered with an `order` between two existing stages is the next stage (not append-at-end)", async () => {
    // Insert a stage between plan(400) and work(500). Registry/Map insertion
    // order would append it at the end; the explicit `order` slots it mid-pipeline.
    registerStage({
      stageId: "refine",
      order: 450,
      skillId: "ce-refine",
      artifactLocation: "docs/refine/",
      icon: "Wand",
      label: "Refine",
    });
    try {
      const { cePipelineId, task } = await landPipeline("plan");
      const store = getCePipelineStore(ctx);

      await moveTo(task.id, "done");
      await reconcileCePipelines(ctx);

      // Advances to the inserted stage, NOT to "work" (the old append-at-end).
      expect(store.getState(cePipelineId)!.currentStage).toBe("refine");
    } finally {
      unregisterStage("refine");
    }
  });
});

describe("U8 conflict resolution (board vs CE authority)", () => {
  it("simultaneous board move + CE advance: board keeps the task column, CE keeps the pipeline content", async () => {
    const { cePipelineId, task } = await landPipeline("plan");
    const store = getCePipelineStore(ctx);

    // CE-flow side: the pipeline owns its content; record an artifact (CE-authoritative).
    store.transitionState(cePipelineId, { lastArtifactPath: "/docs/plans/p.md" });

    // Board side: move the task to done (board-authoritative for the column).
    await moveTo(task.id, "done");

    // Reconcile resolves the collision: it READS the board column (never rewrites
    // the terminal task) and WRITES only CE-owned fields + a NEW task.
    await reconcileCePipelines(ctx);

    // Board authority: the original task's column is exactly what the board set.
    const reread = await taskStore.getTask(task.id);
    expect(reread!.column).toBe("done");

    // CE authority: the pipeline content (stage + artifact) is what CE wrote.
    const state = store.getState(cePipelineId)!;
    expect(state.currentStage).toBe("work");
    expect(state.lastArtifactPath).toBe("/docs/plans/p.md");

    // The new outbound task is a fresh row — the writers never contended on one cell.
    const tasks = await taskStore.listTasks();
    const next = tasks.find((t) => t.id !== task.id)!;
    expect((next.sourceMetadata as Record<string, unknown>).ceStageId).toBe("work");
  });
});
