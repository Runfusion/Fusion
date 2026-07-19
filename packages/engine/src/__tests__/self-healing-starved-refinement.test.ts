import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { TriageProcessor } from "../triage.js";

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const { id, ...rest } = overrides;
  return {
    id,
    title: overrides.id,
    description: overrides.id,
    column: "triage",
    priority: "normal",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: null,
    createdAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:00:00.000Z",
    columnMovedAt: "2026-05-15T10:00:00.000Z",
    ...rest,
  } as Task;
}

describe("SelfHealingManager.recoverStarvedRefinementTriageTasks", () => {
  it("escalates starved refinements once and emits run-audit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));

    const tasks: Task[] = [
      task({ id: "FN-R1", sourceType: "task_refine", createdAt: "2026-05-15T10:00:00.000Z", updatedAt: "2026-05-15T10:00:00.000Z", priority: "low" }),
      task({ id: "FN-P1", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:15:00.000Z" }),
      task({ id: "FN-P2", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:16:00.000Z" }),
      task({ id: "FN-P3", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:17:00.000Z" }),
    ];

    const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
      const idx = tasks.findIndex((t) => t.id === id);
      tasks[idx] = { ...tasks[idx], ...patch, updatedAt: new Date().toISOString() } as Task;
    });
    const recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const store: any = {
      getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false }),
      listTasks: vi.fn().mockResolvedValue(tasks),
      updateTask,
      logEntry: vi.fn().mockResolvedValue(undefined),
      recordRunAuditEvent,
      on: () => {},
      removeListener: () => {},
    };

    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getPlanningTaskIds: () => new Set() });
    await expect(manager.recoverStarvedRefinementTriageTasks()).resolves.toBe(1);
    await expect(manager.recoverStarvedRefinementTriageTasks()).resolves.toBe(0);

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith("FN-R1", { priority: "normal" });
    expect(recordRunAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordRunAuditEvent.mock.calls[0][0]).toMatchObject({ mutationType: "task:auto-recover-starved-refinement", target: "FN-R1" });
    vi.useRealTimers();
  });

  it("does not escalate non-refinement triage tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));
    const store: any = {
      listTasks: vi.fn().mockResolvedValue([
        task({ id: "FN-NON", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:00:00.000Z" }),
        task({ id: "FN-P1", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:15:00.000Z" }),
        task({ id: "FN-P2", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:16:00.000Z" }),
        task({ id: "FN-P3", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:17:00.000Z" }),
      ]),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      recordRunAuditEvent: vi.fn(),
      on: () => {},
      removeListener: () => {},
    };
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getPlanningTaskIds: () => new Set() });
    await expect(manager.recoverStarvedRefinementTriageTasks()).resolves.toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not escalate refinements under grace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));
    const store: any = {
      listTasks: vi.fn().mockResolvedValue([
        task({ id: "FN-YOUNG", sourceType: "task_refine", createdAt: "2026-05-15T10:55:00.000Z", updatedAt: "2026-05-15T10:55:00.000Z" }),
        task({ id: "FN-P1", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:56:00.000Z" }),
        task({ id: "FN-P2", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:57:00.000Z" }),
        task({ id: "FN-P3", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:58:00.000Z" }),
      ]),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      recordRunAuditEvent: vi.fn(),
      on: () => {},
      removeListener: () => {},
    };
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getPlanningTaskIds: () => new Set() });
    await expect(manager.recoverStarvedRefinementTriageTasks()).resolves.toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not escalate aged refinements when peer progress threshold is not met", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));
    const store: any = {
      listTasks: vi.fn().mockResolvedValue([
        task({ id: "FN-IDLE", sourceType: "task_refine", createdAt: "2026-05-15T10:00:00.000Z", updatedAt: "2026-05-15T10:00:00.000Z" }),
      ]),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      recordRunAuditEvent: vi.fn(),
      on: () => {},
      removeListener: () => {},
    };
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getPlanningTaskIds: () => new Set() });
    await expect(manager.recoverStarvedRefinementTriageTasks()).resolves.toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not escalate paused refinements", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));
    const store: any = {
      listTasks: vi.fn().mockResolvedValue([
        task({ id: "FN-PAUSED", sourceType: "task_refine", paused: true, createdAt: "2026-05-15T10:00:00.000Z", updatedAt: "2026-05-15T10:00:00.000Z" }),
        task({ id: "FN-P1", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:15:00.000Z" }),
        task({ id: "FN-P2", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:16:00.000Z" }),
        task({ id: "FN-P3", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:17:00.000Z" }),
      ]),
      updateTask: vi.fn(),
      logEntry: vi.fn(),
      recordRunAuditEvent: vi.fn(),
      on: () => {},
      removeListener: () => {},
    };
    const manager = new SelfHealingManager(store, { rootDir: process.cwd(), getPlanningTaskIds: () => new Set() });
    await expect(manager.recoverStarvedRefinementTriageTasks()).resolves.toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("preserves approval gate flow (never direct todo) after escalation", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn4662-"));
    try {
      const refinement = task({ id: "FN-RG", sourceType: "task_refine" });
      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);

      const store: any = {
        listTasks: vi.fn().mockResolvedValue([
          refinement,
          task({ id: "FN-P1", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:15:00.000Z" }),
          task({ id: "FN-P2", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:16:00.000Z" }),
          task({ id: "FN-P3", column: "todo", sourceType: "dashboard_ui", updatedAt: "2026-05-15T10:17:00.000Z" }),
        ]),
        updateTask,
        moveTask,
        logEntry: vi.fn().mockResolvedValue(undefined),
        recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
        parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
        parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
        on: () => {},
        off: () => {},
        removeListener: () => {},
      };

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-15T11:00:00.000Z"));
      const manager = new SelfHealingManager(store, { rootDir: root, getPlanningTaskIds: () => new Set() });
      await manager.recoverStarvedRefinementTriageTasks();
      expect(moveTask).not.toHaveBeenCalled();

      const taskDir = join(root, ".fusion", "tasks", "FN-RG");
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, "PROMPT.md"), "# FN-RG\n\n## File Scope\n- packages/engine/src/self-healing.ts\n", "utf-8");
      const processor = new TriageProcessor(store, root);
      await (processor as any).finalizeApprovedTask(refinement, "# FN-RG\n\n## File Scope\n- packages/engine/src/self-healing.ts\n", { requirePlanApproval: true });
      expect(updateTask).toHaveBeenCalledWith("FN-RG", expect.objectContaining({ status: "awaiting-approval" }));
      expect(moveTask).not.toHaveBeenCalled();
      vi.useRealTimers();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /*
   * FNXC:PlanApproval 2026-07-04-12:20:
   * FN-7526 — locks the auto-approve-all invariant for the starved-refinement
   * finalize surface specifically, using the REAL mergeEffectiveSettings pipeline
   * (not a bare `{ requirePlanApproval }` object) so a project auto-approve-all
   * override still wins even when the stored workflow value would otherwise
   * require manual plan approval. This is the surface `recoverApprovedTask`
   * exercises when self-healing recovers a starved refinement stuck in
   * `status: "planning"`.
   */
  it("moves a starved refinement to todo when project auto-approve-all overrides stored workflow approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-fn7526-refine-"));
    try {
      const taskDir = join(root, ".fusion", "tasks", "FN-RG2");
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, "PROMPT.md"), "# FN-RG2\n\n## File Scope\n- packages/engine/src/self-healing.ts\n", "utf-8");

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const refinement = task({
        id: "FN-RG2",
        sourceType: "task_refine",
        status: "planning",
        log: [{ timestamp: "2026-05-15T10:00:00.000Z", action: "Spec review: APPROVE" }],
      });
      const store: any = {
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          pollIntervalMs: 10000,
          groupOverlappingFiles: false,
          autoMerge: true,
          planApprovalMode: "auto-approve-all",
          requirePlanApproval: false,
        }),
        getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
        getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
        getWorkflowSettingValues: vi.fn().mockReturnValue({ requirePlanApproval: true }),
        getWorkflowSettingsProjectId: vi.fn().mockReturnValue("project-auto-approval"),
        // FNXC:EngineTests 2026-07-19-01:20: finalizeApprovedTaskBody re-reads live task via getTask.
        getTask: vi.fn().mockImplementation(async (id: string) => (id === "FN-RG2" ? refinement : undefined)),
        updateTask,
        moveTask,
        logEntry: vi.fn().mockResolvedValue(undefined),
        parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
        parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
        on: () => {},
        off: () => {},
        removeListener: () => {},
      };

      const processor = new TriageProcessor(store, root);
      const recovered = await processor.recoverApprovedTask(refinement);

      expect(recovered).toBe(true);
      expect(moveTask).toHaveBeenCalledWith("FN-RG2", "todo");
      expect(updateTask).not.toHaveBeenCalledWith("FN-RG2", expect.objectContaining({ status: "awaiting-approval" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
