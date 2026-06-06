// Company-model U5 — the Lead absorbs triage.
//
// Covers (per the U5 plan test scenarios):
//  - flag-on company board: a todo task without a spec gets PROMPT.md authored
//    under the Lead identity, then advances to in-progress (Lead actor).
//  - approval hold: with requirePlanApproval on, Lead completion parks the task
//    (stays todo, awaiting-approval marker, no move); off → advances directly.
//  - migrated mid-planning task resumes via recoverApprovedTask on the Lead
//    column without restarting spec generation.
//  - flag off / no resolver: finalize moves to todo exactly as today (parity).
//  - recovery re-target: the scheduler's recovery column resolver returns the
//    company Lead column for a company board and `triage` for a flag-off board.
//  - stuck-detection exclusion: an approval-parked (awaiting-approval) task past
//    the poll gate is NOT discovered/dispatched by the triage scan.
//  - no double-processing: a company todo task WITH a spec is not re-specified by
//    the company scan.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskStore, Task, TaskDetail, Settings, WorkflowIr } from "@fusion/core";
import { TriageProcessor } from "../triage.js";
import { Scheduler } from "../scheduler.js";
import { join } from "node:path";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const { mockReviewStep, mockCreateFnAgent } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("../reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  describeModel: vi.fn().mockReturnValue("mock-model"),
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveAgentPrompt: vi.fn().mockReturnValue(null),
  });
});

// A minimal company-board IR carrying a Lead role marker on `todo`.
const companyIr: WorkflowIr = {
  version: "v2",
  id: "builtin:company",
  name: "Company",
  columns: [
    { id: "todo", name: "Todo", traits: [], role: "lead" },
    { id: "in-progress", name: "In Progress", traits: [], role: "executor" },
    { id: "in-review", name: "In Review", traits: [], role: "reviewer" },
    { id: "done", name: "Done", traits: [] },
  ],
  nodes: [{ id: "start", kind: "start", column: "todo" }],
  edges: [],
} as unknown as WorkflowIr;

async function fixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
async function cleanup(rootDir: string | undefined): Promise<void> {
  if (rootDir) await rm(rootDir, { recursive: true, force: true }).catch(() => {});
}

const baseDetail: TaskDetail = {
  id: "FN-100",
  description: "Build a thing",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  log: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  prompt: "",
  attachments: [],
  comments: [],
} as unknown as TaskDetail;

function companyTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-100",
    description: "Build a thing",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    executionMode: "fast",
    ...overrides,
  } as Task;
}

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn().mockResolvedValue({ ...baseDetail }),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn().mockResolvedValue({ ...baseDetail }),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 10000,
      groupOverlappingFiles: false,
      autoMerge: true,
    } as Settings),
    mergeTask: vi.fn(),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    recordActivity: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    parseDependenciesFromPrompt: vi.fn().mockResolvedValue([]),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    getTasksDir: vi.fn().mockReturnValue("/tmp/tasks"),
    getRootDir: vi.fn().mockReturnValue("/tmp"),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    // Effective-settings merge dependencies (degrade to base on error / empty).
    getTaskWorkflowSelection: vi.fn().mockResolvedValue(null),
    getWorkflowDefinition: vi.fn().mockResolvedValue(null),
    getWorkflowSettingValues: vi.fn().mockResolvedValue({}),
    getWorkflowSettingsProjectId: vi.fn().mockReturnValue(""),
    ...overrides,
  } as unknown as TaskStore;
}

/** Drive specifyTask through the fast-mode auto-approve path: the agent writes
 *  PROMPT.md and calls fn_review_spec (auto-APPROVE in fast mode). */
async function wireAgentToWriteSpec(rootDir: string, taskId: string): Promise<void> {
  const capturedTools: { current: any[] } = { current: [] };
  mockCreateFnAgent.mockImplementationOnce(async (opts: any) => {
    capturedTools.current = opts.customTools;
    return {
      session: {
        state: {},
        sessionManager: { getLeafId: vi.fn().mockReturnValue(null) },
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        navigateTree: vi.fn(),
      },
    };
  });
  const { promptWithFallback } = await import("../pi.js");
  (promptWithFallback as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
    const promptPath = join(rootDir, ".fusion", "tasks", taskId, "PROMPT.md");
    await writeFile(promptPath, `# Task: ${taskId} - Thing\n\n## Mission\n\nShip it.`);
    const reviewTool = capturedTools.current.find((tool) => tool.name === "fn_review_spec");
    await reviewTool.execute({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("U5 Lead absorbs triage — finalize advances company todo task forward", () => {
  it("flag-on company board: spec authored under Lead, then advances todo→in-progress (Lead actor)", async () => {
    const rootDir = await fixtureRoot("lead-triage-advance-");
    try {
      const task = companyTask();
      await mkdir(join(rootDir, ".fusion", "tasks", task.id), { recursive: true });
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...baseDetail, id: task.id }),
      });
      await wireAgentToWriteSpec(rootDir, task.id);

      const processor = new TriageProcessor(store, rootDir, {
        resolveLeadTriageContext: async () => ({
          leadColumnId: "todo",
          leadAgentId: "lead-agent-1",
          requirePlanApproval: false,
        }),
      });
      await processor.specifyTask(task);

      // Advanced forward to in-progress, NOT moved to "todo", with Lead actor.
      expect(store.moveTask).toHaveBeenCalledWith(
        task.id,
        "in-progress",
        { actor: { kind: "agent", agentId: "lead-agent-1" } },
      );
      expect(store.moveTask).not.toHaveBeenCalledWith(task.id, "todo");
    } finally {
      await cleanup(rootDir);
    }
  });

  it("approval hold ON: parks the task in todo with awaiting-approval and never moves", async () => {
    const rootDir = await fixtureRoot("lead-triage-hold-");
    try {
      const task = companyTask({ id: "FN-101" });
      await mkdir(join(rootDir, ".fusion", "tasks", task.id), { recursive: true });
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...baseDetail, id: task.id }),
      });
      await wireAgentToWriteSpec(rootDir, task.id);

      const processor = new TriageProcessor(store, rootDir, {
        resolveLeadTriageContext: async () => ({
          leadColumnId: "todo",
          leadAgentId: "lead-agent-1",
          requirePlanApproval: true,
        }),
      });
      await processor.specifyTask(task);

      // Parked in place: marker stamped, no move.
      expect(store.updateTask).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({ status: "awaiting-approval" }),
      );
      expect(store.moveTask).not.toHaveBeenCalled();
    } finally {
      await cleanup(rootDir);
    }
  });

  it("flag-off (no resolver): finalize moves the task to todo exactly as today", async () => {
    const rootDir = await fixtureRoot("lead-triage-legacy-");
    try {
      // Legacy triage-column task; no resolveLeadTriageContext provided.
      const task = companyTask({ id: "FN-102", column: "triage" });
      await mkdir(join(rootDir, ".fusion", "tasks", task.id), { recursive: true });
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...baseDetail, id: task.id, column: "triage" }),
      });
      await wireAgentToWriteSpec(rootDir, task.id);

      const processor = new TriageProcessor(store, rootDir);
      await processor.specifyTask(task);

      expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo");
      expect(store.moveTask).not.toHaveBeenCalledWith(task.id, "in-progress", expect.anything());
    } finally {
      await cleanup(rootDir);
    }
  });
});

describe("U5 — migrated mid-planning task resumes via recovery on the Lead column", () => {
  it("recoverApprovedTask advances a company todo planning task to in-progress without restarting spec generation", async () => {
    const rootDir = await fixtureRoot("lead-triage-recover-");
    try {
      const taskId = "FN-110";
      const taskDir = join(rootDir, ".fusion", "tasks", taskId);
      await mkdir(taskDir, { recursive: true });
      // The migrated task already carries an in-flight PROMPT.md — recovery must
      // NOT regenerate it; it only completes the stuck handoff.
      await writeFile(join(taskDir, "PROMPT.md"), `# Task: ${taskId} - Migrated\n\n## Mission\n\nResume.`);

      const task = companyTask({
        id: taskId,
        column: "todo",
        status: "planning",
        // hasLatestSpecReviewApproval reads the task's log for an APPROVE entry.
        log: [{ action: "Spec review: APPROVE", timestamp: "2026-01-01T00:00:00.000Z" }],
      } as Partial<Task>);

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue({ ...baseDetail, id: taskId, column: "todo", status: "planning", log: task.log }),
      });

      const processor = new TriageProcessor(store, rootDir, {
        resolveLeadTriageContext: async () => ({
          leadColumnId: "todo",
          leadAgentId: "lead-agent-1",
          requirePlanApproval: false,
        }),
      });

      const recovered = await processor.recoverApprovedTask(task);

      expect(recovered).toBe(true);
      // No new agent session was spun up (spec generation not restarted).
      expect(mockCreateFnAgent).not.toHaveBeenCalled();
      expect(store.moveTask).toHaveBeenCalledWith(
        taskId,
        "in-progress",
        { actor: { kind: "agent", agentId: "lead-agent-1" } },
      );
    } finally {
      await cleanup(rootDir);
    }
  });
});

describe("U5 — company todo scan picks up needs-spec tasks but not specced/parked ones", () => {
  it("no double-processing: a company todo task WITH a spec is not dispatched to specifyTask", async () => {
    const rootDir = await fixtureRoot("lead-triage-nodouble-");
    try {
      const taskId = "FN-120";
      const taskDir = join(rootDir, ".fusion", "tasks", taskId);
      await mkdir(taskDir, { recursive: true });
      await writeFile(join(taskDir, "PROMPT.md"), `# Task: ${taskId}\n\nAlready specced.`);

      const todoTask = companyTask({ id: taskId, column: "todo" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([todoTask]),
      });

      const processor = new TriageProcessor(store, rootDir, {
        resolveLeadTriageContext: async () => ({
          leadColumnId: "todo",
          leadAgentId: "lead-agent-1",
          requirePlanApproval: false,
        }),
      });
      const specifySpy = vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);

      (processor as any).running = true;
      await (processor as any).poll();

      expect(specifySpy).not.toHaveBeenCalled();
    } finally {
      await cleanup(rootDir);
    }
  });

  it("scan picks up a company todo task WITHOUT a spec", async () => {
    const rootDir = await fixtureRoot("lead-triage-pickup-");
    try {
      const taskId = "FN-121";
      await mkdir(join(rootDir, ".fusion", "tasks", taskId), { recursive: true });
      // No PROMPT.md written → needs spec.

      const todoTask = companyTask({ id: taskId, column: "todo" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([todoTask]),
      });

      const processor = new TriageProcessor(store, rootDir, {
        resolveLeadTriageContext: async () => ({
          leadColumnId: "todo",
          leadAgentId: "lead-agent-1",
          requirePlanApproval: false,
        }),
      });
      const specifySpy = vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);

      (processor as any).running = true;
      await (processor as any).poll();

      expect(specifySpy).toHaveBeenCalledTimes(1);
      expect(specifySpy.mock.calls[0][0].id).toBe(taskId);
    } finally {
      await cleanup(rootDir);
    }
  });

  it("an idea-column task is never specified/dispatched (the scan gates on the todo column)", async () => {
    const rootDir = await fixtureRoot("lead-triage-idea-");
    try {
      const taskId = "FN-IDEA-1";
      // No PROMPT.md → would need a spec IF it were on the todo column; but it
      // sits on the unstaffed `idea` intake column, which the scan never touches.
      await mkdir(join(rootDir, ".fusion", "tasks", taskId), { recursive: true });

      const ideaTask = companyTask({ id: taskId, column: "idea" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([ideaTask]),
      });

      const processor = new TriageProcessor(store, rootDir, {
        resolveLeadTriageContext: async () => ({
          leadColumnId: "todo",
          leadAgentId: "lead-agent-1",
          requirePlanApproval: false,
        }),
      });
      const specifySpy = vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);

      (processor as any).running = true;
      await (processor as any).poll();

      // The idea column is not the Lead column (todo), so the task is never
      // discovered for specification or dispatch.
      expect(specifySpy).not.toHaveBeenCalled();
    } finally {
      await cleanup(rootDir);
    }
  });

  it("stuck-detection exclusion: an awaiting-approval parked task is not discovered/dispatched", async () => {
    const rootDir = await fixtureRoot("lead-triage-parked-");
    try {
      const taskId = "FN-122";
      await mkdir(join(rootDir, ".fusion", "tasks", taskId), { recursive: true });

      const parked = companyTask({ id: taskId, column: "todo", status: "awaiting-approval" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([parked]),
      });

      const ctx = vi.fn().mockResolvedValue({
        leadColumnId: "todo",
        leadAgentId: "lead-agent-1",
        requirePlanApproval: true,
      });
      const processor = new TriageProcessor(store, rootDir, {
        resolveLeadTriageContext: ctx,
      });
      const specifySpy = vi.spyOn(processor, "specifyTask").mockResolvedValue(undefined);

      (processor as any).running = true;
      await (processor as any).poll();

      // The common gate drops awaiting-approval tasks before the resolver runs.
      expect(specifySpy).not.toHaveBeenCalled();
    } finally {
      await cleanup(rootDir);
    }
  });
});

describe("U5 — scheduler recovery re-targets to the Lead column on company boards", () => {
  beforeEach(async () => {
    const core = await import("@fusion/core");
    (core.isCompanyModelEnabled as ReturnType<typeof vi.fn>)?.mockReset?.();
    (core.resolveWorkflowIrForTask as ReturnType<typeof vi.fn>)?.mockReset?.();
  });

  it("company board → recovery column is the Lead column (todo), never triage", async () => {
    const core = await import("@fusion/core");
    vi.spyOn(core, "isCompanyModelEnabled").mockReturnValue(true);
    vi.spyOn(core, "resolveWorkflowIrForTask").mockResolvedValue(companyIr);

    const store = createMockStore();
    const scheduler = new Scheduler(store);
    const settings = { experimentalFeatures: { companyModel: true } } as unknown as Settings;

    const column = await (scheduler as any).resolveTriageRecoveryColumn("FN-130", settings);
    expect(column).toBe("todo");
  });

  it("flag off → recovery column is triage (byte-identical legacy behavior)", async () => {
    const core = await import("@fusion/core");
    vi.spyOn(core, "isCompanyModelEnabled").mockReturnValue(false);

    const store = createMockStore();
    const scheduler = new Scheduler(store);
    const settings = {} as Settings;

    const column = await (scheduler as any).resolveTriageRecoveryColumn("FN-131", settings);
    expect(column).toBe("triage");
  });

  it("flag on but legacy (non-company) board → recovery column is triage", async () => {
    const core = await import("@fusion/core");
    vi.spyOn(core, "isCompanyModelEnabled").mockReturnValue(true);
    vi.spyOn(core, "resolveWorkflowIrForTask").mockResolvedValue({
      version: "v2",
      id: "builtin:coding",
      name: "Coding",
      columns: [{ id: "triage", name: "Triage", traits: [] }],
      nodes: [],
      edges: [],
    } as unknown as WorkflowIr);

    const store = createMockStore();
    const scheduler = new Scheduler(store);
    const settings = { experimentalFeatures: { companyModel: true } } as unknown as Settings;

    const column = await (scheduler as any).resolveTriageRecoveryColumn("FN-132", settings);
    expect(column).toBe("triage");
  });
});
