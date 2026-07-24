import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";
import { TriageProcessor } from "../triage.js";

function withStoreEvents<T extends Record<string, unknown>>(store: T): T & { on: () => void; off: () => void } {
  return {
    on: () => {},
    off: () => {},
    ...store,
  };
}


/*
FNXC:EngineTests 2026-07-21-00:10:
Finalization/recovery withholds when coding workflow requires step headings and the
spec has none. Spec fixtures used for finalizeApprovedTask / recoverApprovedTask need
an executable Steps section (or **No commits expected**).
*/
function executableSpec(body: string): string {
  if (body.includes("## Steps") || /^\*\*No commits expected:\*\*/im.test(body)) return body;
  return `${body.trim()}\n\n## Steps\n\n### Step 0: Implement\n- [ ] do the work\n`;
}

function createTriageTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  const now = "2026-05-15T12:00:00.000Z";
  const { id, ...rest } = overrides;
  return {
    id,
    title: overrides.title ?? id,
    description: overrides.description ?? id,
    priority: overrides.priority ?? "normal",
    column: "triage",
    steps: [],
    currentStep: 0,
    dependencies: [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    columnMovedAt: overrides.columnMovedAt ?? now,
    ...rest,
  } as Task;
}

describe("refinement routing from triage", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "fusion-triage-refine-"));
    roots.push(root);
    await mkdir(join(root, ".fusion", "tasks"), { recursive: true });
    return root;
  }

  it("promotes a refinement to todo within bounded polls under same-priority backlog", async () => {
    const rootDir = await createRoot();
    const refinement = createTriageTask({
      id: "FN-R1",
      sourceType: "task_refine",
      sourceParentTaskId: "FN-123",
      createdAt: "2026-05-15T12:00:00.000Z",
    });

    const tasks: Task[] = [
      refinement,
      ...Array.from({ length: 8 }, (_, i) => createTriageTask({
        id: `FN-B${i + 1}`,
        createdAt: `2026-05-15T11:${String(10 + i).padStart(2, "0")}:00.000Z`,
      })),
    ];

    const store: any = withStoreEvents({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxTriageConcurrent: 2,
        pollIntervalMs: 10_000,
        groupOverlappingFiles: false,
        autoMerge: true,
      }),
      listTasks: vi.fn().mockImplementation(async () => tasks.map((t) => ({ ...t }))),
    });

    const processor = new TriageProcessor(store, rootDir);
    const specifySpy = vi.spyOn(processor, "specifyTask").mockImplementation(async (task) => {
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx >= 0) tasks[idx] = { ...tasks[idx], column: "todo" };
    });

    (processor as any).running = true;
    /*
    FNXC:EngineTests 2026-07-23-21:30:
    FN-8453 (commit eef5eb751) replaced priority-then-refinement triage ordering with the
    unified oldest-createdAt-first admission coordinator. Refinements no longer jump the
    same-priority backlog; the no-starvation invariant is now FIFO fairness — the newest
    refinement behind an 8-task backlog at maxConcurrent=2 must be admitted within
    ceil(9/2)=5 bounded polls.
    */
    for (let i = 0; i < 5; i++) {
      await (processor as any).poll();
      if (tasks.find((t) => t.id === refinement.id)?.column === "todo") break;
    }

    expect(tasks.find((t) => t.id === refinement.id)?.column).toBe("todo");
    expect(specifySpy.mock.calls.some(([task]) => task.id === refinement.id)).toBe(true);
  });

  it("preserves approval gate for refinements when plan approval is required", async () => {
    const rootDir = await createRoot();
    const promptPath = join(rootDir, ".fusion", "tasks", "FN-R2", "PROMPT.md");
    await mkdir(join(rootDir, ".fusion", "tasks", "FN-R2"), { recursive: true });
    await writeFile(promptPath, "# FN-R2\n\n## File Scope\n- packages/engine/src/triage.ts\n");

    const updates: Array<Record<string, unknown>> = [];
    const moves: string[] = [];
    const task = createTriageTask({ id: "FN-R2", sourceType: "task_refine", sourceParentTaskId: "FN-001" });
    const store: any = withStoreEvents({
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
      parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
      parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
      getTask: vi.fn().mockImplementation(async (id: string) => (id === "FN-R2" ? task : undefined)),
      updateTask: vi.fn().mockImplementation(async (_id: string, update: Record<string, unknown>) => {
        updates.push(update);
      }),
      moveTask: vi.fn().mockImplementation(async (_id: string, to: string) => {
        moves.push(to);
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
    store.moveTaskIf = vi.fn(async (id: string, column: string, predicate: (live: any) => boolean) => {
      const live = typeof store.getTask === "function" ? await store.getTask(id) : undefined;
      if (live && !predicate(live)) return { moved: false, task: live };
      await store.moveTask(id, column);
      return { moved: true, task: live ? { ...live, column, status: null } : { id, column, status: null } };
    });
    store.withTaskLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    store.readTaskForMove = vi.fn(async (id: string) => (typeof store.getTask === "function" ? store.getTask(id) : undefined));

    const processor = new TriageProcessor(store, rootDir);

    await (processor as any).finalizeApprovedTask(
      task,
      executableSpec("# FN-R2\n\n## File Scope\n- packages/engine/src/triage.ts\n"),
      { requirePlanApproval: true },
    );

    expect(updates.some((u) => u.status === "awaiting-approval")).toBe(true);
    expect(moves).toEqual([]);
  });

  it("keeps spec prompt present before move-to-todo on refinement finalize", async () => {
    const rootDir = await createRoot();
    const taskId = "FN-R3";
    const taskDir = join(rootDir, ".fusion", "tasks", taskId);
    const promptPath = join(taskDir, "PROMPT.md");
    await mkdir(taskDir, { recursive: true });
    await writeFile(promptPath, "# FN-R3\n\n## File Scope\n- packages/engine/src/triage.ts\n");

    const task = createTriageTask({ id: taskId, sourceType: "task_refine", sourceParentTaskId: "FN-002" });
    const store: any = withStoreEvents({
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
      parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
      // FNXC:EngineTests 2026-07-19-01:20: finalizeApprovedTaskBody re-reads live task via getTask.
      getTask: vi.fn().mockImplementation(async (id: string) => (id === taskId ? task : undefined)),
      updateTask: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockImplementation(async () => {
        const prompt = await readFile(promptPath, "utf8");
        expect(prompt.trim().length).toBeGreaterThan(0);
        expect(prompt).toContain("## File Scope");
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
    store.moveTaskIf = vi.fn(async (id: string, column: string, predicate: (live: any) => boolean) => {
      const live = typeof store.getTask === "function" ? await store.getTask(id) : undefined;
      if (live && !predicate(live)) return { moved: false, task: live };
      await store.moveTask(id, column);
      return { moved: true, task: live ? { ...live, column, status: null } : { id, column, status: null } };
    });
    store.withTaskLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    store.readTaskForMove = vi.fn(async (id: string) => (typeof store.getTask === "function" ? store.getTask(id) : undefined));
    if (!store.parseFileScopeFromPrompt) store.parseFileScopeFromPrompt = vi.fn().mockResolvedValue([]);


    const processor = new TriageProcessor(store, rootDir);

    await (processor as any).finalizeApprovedTask(
      task,
      executableSpec("# FN-R3\n\n## File Scope\n- packages/engine/src/triage.ts\n"),
      { requirePlanApproval: false },
    );

    expect(store.moveTask).toHaveBeenCalledWith(taskId, "todo");
  });

  /*
   * FNXC:PlanApproval 2026-07-04-12:22:
   * FN-7526 — locks the auto-approve-all invariant specifically for refinement
   * (`sourceType: "task_refine"`) tasks routed through the real mergeEffectiveSettings
   * pipeline (recoverApprovedTask), not just the isolated finalizeApprovedTask unit
   * calls above which pass a bare `{ requirePlanApproval }` object. Proves the
   * settings object handed to finalizeApprovedTask for a refinement still carries
   * the project planApprovalMode even when the workflow has a stored
   * requirePlanApproval: true value.
   */
  it("moves a refinement to todo when project auto-approve-all overrides stored workflow approval", async () => {
    const rootDir = await createRoot();
    const taskId = "FN-R4";
    const taskDir = join(rootDir, ".fusion", "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), executableSpec("# FN-R4\n\n## File Scope\n- packages/engine/src/triage.ts\n"));

    const task = createTriageTask({
      id: taskId,
      sourceType: "task_refine",
      sourceParentTaskId: "FN-003",
      status: "planning",
      log: [{ timestamp: "2026-05-15T12:00:00.000Z", action: "Spec review: APPROVE" }],
    });
    const store: any = withStoreEvents({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxTriageConcurrent: 2,
        pollIntervalMs: 10_000,
        groupOverlappingFiles: false,
        autoMerge: true,
        planApprovalMode: "auto-approve-all",
        requirePlanApproval: false,
      }),
      getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId: "builtin:coding", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
      getWorkflowSettingValues: vi.fn().mockReturnValue({ requirePlanApproval: true }),
      getWorkflowSettingsProjectId: vi.fn().mockReturnValue("project-auto-approval"),
      parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
      parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
      // FNXC:EngineTests 2026-07-19-01:20: finalizeApprovedTaskBody re-reads live task via getTask.
      getTask: vi.fn().mockImplementation(async (id: string) => (id === taskId ? task : undefined)),
      updateTask: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    });
    store.moveTaskIf = vi.fn(async (id: string, column: string, predicate: (live: any) => boolean) => {
      const live = typeof store.getTask === "function" ? await store.getTask(id) : undefined;
      if (live && !predicate(live)) return { moved: false, task: live };
      await store.moveTask(id, column);
      return { moved: true, task: live ? { ...live, column, status: null } : { id, column, status: null } };
    });
    store.withTaskLock = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn());
    store.readTaskForMove = vi.fn(async (id: string) => (typeof store.getTask === "function" ? store.getTask(id) : undefined));
    if (!store.parseFileScopeFromPrompt) store.parseFileScopeFromPrompt = vi.fn().mockResolvedValue([]);


    const processor = new TriageProcessor(store, rootDir);

    const recovered = await processor.recoverApprovedTask(task);

    expect(recovered).toBe(true);
    expect(store.moveTask).toHaveBeenCalledWith(taskId, "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith(taskId, expect.objectContaining({ status: "awaiting-approval" }));
  });

  it("retains baseline ordering for non-refinement triage tasks", async () => {
    const rootDir = await createRoot();
    const tasks: Task[] = [
      createTriageTask({ id: "FN-101", priority: "urgent", createdAt: "2026-05-15T10:00:00.000Z" }),
      createTriageTask({ id: "FN-102", priority: "high", createdAt: "2026-05-15T10:02:00.000Z" }),
      createTriageTask({ id: "FN-103", priority: "high", createdAt: "2026-05-15T10:01:00.000Z" }),
      createTriageTask({ id: "FN-100", priority: "normal", createdAt: "2026-05-15T09:00:00.000Z" }),
    ];

    const store: any = withStoreEvents({
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 10,
        maxTriageConcurrent: 10,
        pollIntervalMs: 10_000,
        groupOverlappingFiles: false,
        autoMerge: true,
      }),
      listTasks: vi.fn().mockResolvedValue(tasks),
    });

    const processor = new TriageProcessor(store, rootDir);
    const specifySpy = vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);

    (processor as any).running = true;
    await (processor as any).poll();

    /*
    FNXC:EngineTests 2026-07-23-21:30:
    FN-8453 (commit eef5eb751) removed priority ranking from triage admission: the baseline
    ordering contract is now strictly oldest-createdAt-first (compareAdmissionCandidates),
    so the oldest normal-priority task dispatches before newer urgent/high tasks.
    */
    expect(specifySpy.mock.calls.map(([task]) => task.id)).toEqual([
      "FN-100",
      "FN-101",
      "FN-103",
      "FN-102",
    ]);
  });
});
