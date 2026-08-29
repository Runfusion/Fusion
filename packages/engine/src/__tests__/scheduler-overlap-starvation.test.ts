import { beforeEach, describe, expect, it, vi } from "vitest";
import { filterPathsByIgnoreList, Scheduler } from "../scheduler.js";
import type { Agent, AgentStore, Settings, Task, TaskStore } from "@fusion/core";

/*
FNXC:PlanReviewStep 2026-07-26-17:10:
The default workflow is plan-in-place: a `todo` card releases only after Plan Review passed, so these
scheduler fixtures model a card that already cleared the gate (the state every real card is in when
the capacity sweep sees it). Holding an unreviewed card is the gate working — that path is owned by
`pre-release-plan-review.test.ts`.
*/
const PASSED_PLAN_REVIEW = {
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed" as const,
  source: "node" as const,
  phase: "pre-merge" as const,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "task",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    workflowStepResults: [PASSED_PLAN_REVIEW],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createAgentStore(agents: Agent[]): AgentStore {
  return {
    listAgents: vi.fn(async (filter?: { state?: Agent["state"]; includeEphemeral?: boolean }) => {
      return agents.filter((agent) => !filter?.state || agent.state === filter.state);
    }),
    getActiveHeartbeatRun: vi.fn(async () => null),
    updateAgentState: vi.fn(async (agentId: string, state: Agent["state"]) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (agent) agent.state = state;
    }),
    syncExecutionTaskLink: vi.fn(async (agentId: string, taskId?: string) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (agent) agent.taskId = taskId;
    }),
  } as unknown as AgentStore;
}

function createStore(tasks: Task[], scopes: Record<string, string[]>, settings: Partial<Settings> = {}): TaskStore {
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) Object.assign(task, patch);
    return task as Task;
  });
  const logEntry = vi.fn(async () => undefined);
  const moveTask = vi.fn(async (id: string, column: Task["column"]) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) task.column = column;
    return task as Task;
  });
  /*
  FNXC:EngineTests 2026-07-23-21:20:
  Scheduler dispatch now goes through the atomic `moveTaskIf` (user-paused dispatch fix, commit 0818fc1da).
  The fake delegates to the mock `moveTask` after the predicate passes so existing dispatch assertions on `store.moveTask` stay meaningful.
  */
  const moveTaskIf = vi.fn(async (id: string, column: Task["column"], predicate: (live: Task) => boolean | Promise<boolean>, opts?: Record<string, unknown>) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) return { task: task as unknown as Task, moved: false };
    if (!(await predicate(task)) || task.column === column) return { task, moved: false };
    const movedTask = await moveTask(id, column, opts);
    return { task: movedTask ?? task, moved: true };
  });

  return {
    listTasks: vi.fn(async () => tasks),
    getSettings: vi.fn(async () => ({ maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: true, ...settings })),
    /*
    FNXC:EngineTests 2026-06-27-10:05:
    Scheduler fakes must mirror the production TaskStore heartbeat surface (`updateSettings`) so active-time writes do not abort overlap scheduling before call-count invariants run in full-suite shards.
    */
    updateSettings: vi.fn(async () => ({ maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: true, ...settings })),
    parseFileScopeFromPrompt: vi.fn(async (id: string) => scopes[id] ?? []),
    updateTask,
    moveTask,
    moveTaskIf,
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
    logEntry,
    transitionQueuedEpisode: vi.fn(async (id: string, transition: { signature: string; blockedBy: string | null; overlapBlockedBy: string | null; action: string }) => {
      const task = tasks.find((candidate) => candidate.id === id)!;
      const appended = !(
        task.status === "queued"
        && (task.blockedBy ?? null) === transition.blockedBy
        && (task.overlapBlockedBy ?? null) === transition.overlapBlockedBy
        && task.queuedLogEpisodeSignature === transition.signature
      );
      await updateTask(id, transition.signature.startsWith("dependency:")
        ? { status: "queued", blockedBy: transition.blockedBy ?? undefined }
        : { status: "queued", blockedBy: transition.blockedBy, overlapBlockedBy: transition.overlapBlockedBy });
      task.queuedLogEpisodeSignature = transition.signature;
      if (appended) await logEntry(id, transition.action);
      return { appended, task };
    }),
    getRootDir: vi.fn(() => "/tmp/project"),
    getTasksDir: vi.fn(() => "/tmp/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

describe("filterPathsByIgnoreList", () => {
  it("ignores hidden top-level files and directories by default", () => {
    expect(filterPathsByIgnoreList([
      ".env",
      ".fusion/tasks/FN-1/PROMPT.md",
      ".changeset/fn-6962.md",
      ".github/workflows/ci.yml",
      "src/foo.ts",
    ])).toEqual(["src/foo.ts"]);
  });

  it("ignores nested hidden directories and Windows separators by default", () => {
    expect(filterPathsByIgnoreList([
      "packages/.cache/out.js",
      "packages\\.vite\\manifest.json",
      "docs/readme.md",
    ])).toEqual(["docs/readme.md"]);
  });

  it("preserves hidden paths when legacy counting is explicitly restored", () => {
    expect(filterPathsByIgnoreList([
      ".env",
      "packages/.cache/out.js",
      "src/foo.ts",
    ], undefined, { ignoreHiddenOverlapPaths: false })).toEqual([".env", "packages/.cache/out.js", "src/foo.ts"]);
  });

  it("applies explicit ignores when hidden filtering is enabled", () => {
    expect(filterPathsByIgnoreList([
      ".fusion/tasks/FN-1/PROMPT.md",
      "docs/readme.md",
      "generated/out.js",
      "src/foo.ts",
    ], ["docs/", "generated/*"])).toEqual(["src/foo.ts"]);
  });

  it("applies explicit ignores when hidden filtering is disabled", () => {
    expect(filterPathsByIgnoreList([
      ".fusion/tasks/FN-1/PROMPT.md",
      "docs/readme.md",
      "generated/out.js",
      "src/foo.ts",
    ], ["docs/", "generated/*"], { ignoreHiddenOverlapPaths: false })).toEqual([".fusion/tasks/FN-1/PROMPT.md", "src/foo.ts"]);
  });

  it("keeps visible paths for empty and blank explicit ignore lists", () => {
    expect(filterPathsByIgnoreList(["src/foo.ts", "docs/readme.md"], [])).toEqual(["src/foo.ts", "docs/readme.md"]);
    expect(filterPathsByIgnoreList(["src/foo.ts", "docs/readme.md"], ["", "  "])).toEqual(["src/foo.ts", "docs/readme.md"]);
  });
});

describe("scheduler overlap starvation regression (FN-057)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Scheduler.prototype as any, "validateTaskFilesystem").mockResolvedValue({ valid: true });
  });

  it("does not let dependency-blocked queued overlap starve ready work", async () => {
    const tasks = [
      makeTask({ id: "FN-039", column: "in-progress", priority: "normal" }),
      makeTask({
        id: "FN-028",
        column: "todo",
        status: "queued",
        priority: "urgent",
        dependencies: ["FN-039"],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeTask({
        id: "FN-030",
        column: "todo",
        priority: "normal",
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
    ];
    const store = createStore(tasks, {
      "FN-039": ["packages/core/src/store.ts"],
      "FN-028": ["packages/engine/src/scheduler.ts"],
      "FN-030": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-028", { status: "queued", blockedBy: "FN-039" });
    expect(store.logEntry).toHaveBeenCalledWith("FN-028", "queued — unmet dependencies: FN-039");
    expect(store.moveTask).toHaveBeenCalledWith("FN-030", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-030",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-028" }),
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-030",
      "queued — deferred for higher-priority runnable queued task FN-028 (overlap)",
    );
  });


  it("does not defer ready work behind queued overlap blocked by an active lease", async () => {
    const tasks = [
      makeTask({ id: "FN-039", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-028", column: "todo", status: "queued", priority: "urgent", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-030", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
    ];
    const store = createStore(tasks, {
      "FN-039": ["packages/engine/src/scheduler.ts"],
      "FN-028": ["packages/engine/src/scheduler.ts", "packages/core/src/store.ts"],
      "FN-030": ["packages/core/src/store.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-028",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-039" }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-030", "in-progress", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-030",
      "queued — deferred for higher-priority runnable queued task FN-028 (overlap)",
    );
  });

  it("ignores hidden-only overlap leases by default when scheduling todo work", async () => {
    const tasks = [
      makeTask({ id: "FN-039", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-030", column: "todo", priority: "urgent" }),
    ];
    const store = createStore(tasks, {
      "FN-039": [".fusion/tasks/FN-039/PROMPT.md", "packages/.cache/out.js"],
      "FN-030": [".fusion/tasks/FN-039/PROMPT.md", "packages/.cache/out.js"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-030", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-030",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-039" }),
    );
  });

  it("counts hidden-only overlap leases when legacy counting is restored", async () => {
    const tasks = [
      makeTask({ id: "FN-039", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-030", column: "todo", priority: "urgent" }),
    ];
    const store = createStore(tasks, {
      "FN-039": [".fusion/tasks/FN-039/PROMPT.md", "packages/.cache/out.js"],
      "FN-030": [".fusion/tasks/FN-039/PROMPT.md", "packages/.cache/out.js"],
    }, { ignoreHiddenOverlapPaths: false });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-030", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-039",
    });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-030", "in-progress", expect.anything());
  });

  it("keeps active file-scope leases bounded while non-overlapping ready work proceeds", async () => {
    const tasks = [
      makeTask({ id: "FN-039", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-030", column: "todo", priority: "urgent" }),
      makeTask({ id: "FN-031", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
    ];
    const store = createStore(tasks, {
      "FN-039": ["packages/engine/src/scheduler.ts"],
      "FN-030": ["packages/engine/src/scheduler.ts"],
      "FN-031": ["packages/core/src/store.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-030", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-039",
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-030",
      "queued — blocked by active file-scope lease FN-039 (column=in-progress)",
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-031", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
  });

  it("FN-6954: clears stale running durable agents when overlap requeue parks todo task", async () => {
    const tasks = [
      makeTask({ id: "FN-6827", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-6709", column: "todo", priority: "urgent" }),
    ];
    const agents = [{ id: "agent-backend", state: "running", taskId: "FN-6709" } as Agent];
    const agentStore = createAgentStore(agents);
    const store = createStore(tasks, {
      "FN-6827": ["packages/engine/src/scheduler.ts"],
      "FN-6709": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store, { agentStore, hasActiveAgentExecution: () => false });
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-6709", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-6827",
    });
    expect(agents[0]).toMatchObject({ state: "active", taskId: undefined });
    expect((agentStore as any).updateAgentState).toHaveBeenCalledWith("agent-backend", "active");
    expect((agentStore as any).syncExecutionTaskLink).toHaveBeenCalledWith("agent-backend", undefined);
    expect(tasks.find((task) => task.id === "FN-6709")).toMatchObject({ status: "queued", overlapBlockedBy: "FN-6827" });
  });

  it("FN-6954: preserves running durable agent when overlap requeue has live execution proof", async () => {
    const tasks = [
      makeTask({ id: "FN-6827", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-6709", column: "todo", priority: "urgent" }),
    ];
    const agents = [{ id: "agent-backend", state: "running", taskId: "FN-6709" } as Agent];
    const agentStore = createAgentStore(agents);
    const store = createStore(tasks, {
      "FN-6827": ["packages/engine/src/scheduler.ts"],
      "FN-6709": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store, { agentStore, hasActiveAgentExecution: (agentId) => agentId === "agent-backend" });
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect((agentStore as any).updateAgentState).not.toHaveBeenCalled();
    expect((agentStore as any).syncExecutionTaskLink).not.toHaveBeenCalled();
    expect(agents[0]).toMatchObject({ state: "running", taskId: "FN-6709" });
    expect(tasks.find((task) => task.id === "FN-6709")).toMatchObject({ status: "queued", overlapBlockedBy: "FN-6827" });
  });

  it("does not defer FN-078-style ready work behind non-runnable queued overlaps", async () => {
    const tasks = [
      makeTask({ id: "FN-069", column: "todo", status: "queued", priority: "high" }),
      makeTask({
        id: "FN-070",
        column: "todo",
        status: "queued",
        priority: "urgent",
        dependencies: ["FN-069"],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeTask({
        id: "FN-045",
        column: "todo",
        status: "queued",
        priority: "high",
        overlapBlockedBy: "FN-033",
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
      makeTask({ id: "FN-033", column: "in-progress", status: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-078", column: "todo", priority: "normal", createdAt: "2026-01-01T00:02:00.000Z" }),
    ];
    const store = createStore(tasks, {
      "FN-033": ["packages/atlas/README.md"],
      "FN-045": ["packages/atlas/README.md"],
      "FN-070": ["packages/atlas/notes.md"],
      "FN-078": ["packages/atlas/notes.md"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-070", { status: "queued", blockedBy: "FN-069" });
    expect(store.logEntry).toHaveBeenCalledWith("FN-070", "queued — unmet dependencies: FN-069");
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-045",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-033" }),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-045",
      "queued — blocked by active file-scope lease FN-033 (column=in-progress)",
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-078", "in-progress", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-078",
      "queued — deferred for higher-priority runnable queued task FN-070 (overlap)",
    );
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-078",
      "queued — deferred for higher-priority runnable queued task FN-045 (overlap)",
    );
  });

  it("allows FN-158-style coordination backlog audit to run while implementation lease is active", async () => {
    const tasks = [
      makeTask({ id: "FN-118", column: "in-progress", priority: "normal", title: "Implement local skill loading" }),
      makeTask({
        id: "FN-158",
        column: "todo",
        status: "queued",
        overlapBlockedBy: "FN-118",
        priority: "normal",
        title: "Backlog flow audit and next-task recommendations",
        description: "Audit backlog routing and document recommendations; no code delivery expected",
        noCommitsExpected: true,
      }),
    ];
    const store = createStore(tasks, {
      "FN-118": ["packages/engine/src/scheduler.ts", ".fusion/tasks/FN-158/task.json"],
      "FN-158": ["docs/task-management.md", ".changeset/*.md", ".fusion/tasks/FN-158/task.json"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-158", "in-progress", expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-158", { overlapBlockedBy: null });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-158",
      "coordination/no-commit task bypassed non-implementation overlap lease",
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-158",
      expect.objectContaining({ overlapBlockedBy: "FN-118" }),
    );
  });

  it("does not use queued candidates that become non-runnable after earlier dispatch in the same pass", async () => {
    const tasks = [
      makeTask({ id: "FN-033", column: "todo", priority: "urgent", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-045", column: "todo", status: "queued", priority: "high", createdAt: "2026-01-01T00:01:00.000Z" }),
      makeTask({ id: "FN-078", column: "todo", priority: "normal", createdAt: "2026-01-01T00:02:00.000Z" }),
    ];
    const store = createStore(tasks, {
      "FN-033": ["packages/atlas/docs/README.md"],
      "FN-045": ["packages/atlas/docs/README.md", "packages/atlas/notes/today.md"],
      "FN-078": ["packages/atlas/notes/today.md"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-033", "in-progress", expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-045",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-033" }),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-045",
      "queued — blocked by active file-scope lease FN-033 (column=in-progress)",
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-078", "in-progress", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-078",
      "queued — deferred for higher-priority runnable queued task FN-045 (overlap)",
    );
  });

  it("clears stale overlapBlockedBy when no runnable queued overlap blocker exists", async () => {
    const tasks = [
      makeTask({ id: "FN-100", column: "todo", priority: "normal", overlapBlockedBy: "FN-070" }),
      makeTask({ id: "FN-070", column: "todo", status: "queued", priority: "urgent", dependencies: ["FN-069"] }),
      makeTask({ id: "FN-069", column: "todo", status: "queued", priority: "high" }),
    ];
    const store = createStore(tasks, {
      "FN-100": ["packages/engine/src/scheduler.ts"],
      "FN-070": ["packages/engine/src/scheduler.ts"],
      "FN-069": ["packages/core/src/store.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-100", { overlapBlockedBy: null });
    expect(store.moveTask).toHaveBeenCalledWith("FN-100", "in-progress", expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-100",
      "queued — deferred for higher-priority runnable queued task FN-070 (overlap)",
    );
  });

  it("does not preserve FN-779/FN-756 poisoned cross-repository blocker after write-scope sanitization", async () => {
    const tasks = [
      makeTask({ id: "FN-756", column: "in-progress", priority: "normal", title: "iPad mobile XCUITest work" }),
      makeTask({
        id: "FN-779",
        column: "todo",
        status: "queued",
        priority: "high",
        overlapBlockedBy: "FN-756",
        title: "Fusion engine heartbeat suppression",
      }),
    ];
    const store = createStore(tasks, {
      "FN-756": ["project.yml", "AtlasNotes.xcodeproj/**", "Tests/AtlasNotesMobileUITests/**", "Packages/MobileApp/**"],
      "FN-779": ["packages/core/**", "packages/engine/**", "packages/dashboard/**", "packages/cli/**"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-779", { overlapBlockedBy: null });
    expect(store.moveTask).toHaveBeenCalledWith("FN-779", "in-progress", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-779",
      expect.objectContaining({ status: "queued", overlapBlockedBy: "FN-756" }),
    );
  });

  it("keeps true Atlas hot-file-family overlaps blocked", async () => {
    const tasks = [
      makeTask({ id: "FN-756", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-800", column: "todo", priority: "high" }),
    ];
    const store = createStore(tasks, {
      "FN-756": ["project.yml", "AtlasNotes.xcodeproj/**", "Tests/AtlasNotesMobileUITests/**", "Packages/MobileApp/**"],
      "FN-800": ["Tests/AtlasNotesMobileUITests/**", "Packages/MobileApp/**"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-800", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-756",
    });
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-800", "in-progress", expect.anything());
  });

  it("reroutes a stale overlap blocker to another current active lease", async () => {
    const tasks = [
      makeTask({ id: "FN-OLD", column: "done", priority: "normal" }),
      makeTask({ id: "FN-NEW", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-900", column: "todo", status: "queued", priority: "high", overlapBlockedBy: "FN-OLD" }),
    ];
    const store = createStore(tasks, {
      "FN-OLD": ["packages/core/src/store.ts"],
      "FN-NEW": ["packages/engine/src/scheduler.ts"],
      "FN-900": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-900", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-NEW",
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-900",
      "queued — blocked by active file-scope lease FN-NEW (column=in-progress)",
    );
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-900", "in-progress", expect.anything());
  });

  it("persists one dependency queue log per full blocker signature across repeated scheduler passes", async () => {
    const tasks = [
      makeTask({ id: "FN-A", column: "todo" }),
      makeTask({ id: "FN-B", column: "todo" }),
      makeTask({ id: "FN-C", column: "todo" }),
      makeTask({ id: "FN-QUEUED", column: "todo", dependencies: ["FN-A", "FN-B"] }),
    ];
    const store = createStore(tasks, {});
    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;

    await scheduler.schedule();
    await scheduler.schedule();
    tasks.find((task) => task.id === "FN-QUEUED")!.dependencies = ["FN-A", "FN-C"];
    await scheduler.schedule();

    const queueLogs = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === "FN-QUEUED" && String(call[1]).startsWith("queued — unmet dependencies"));
    expect(queueLogs).toHaveLength(2);
    expect(queueLogs.map((call) => call[1])).toEqual([
      "queued — unmet dependencies: FN-A, FN-B",
      "queued — unmet dependencies: FN-A, FN-C",
    ]);
  });

  /*
  FNXC:TaskDispatch 2026-08-09-21:04:
  These scheduler fixtures prove hard dependency and active-lease filters run
  before the new priority → age release order consumes capacity. Their limits
  deliberately match occupancy: dependency uses one empty slot; lease uses two
  slots because the live holder consumes one; competing holds use one empty slot.
  */
  it("does not let an older urgent task with an unmet dependency consume the ready slot", async () => {
    const tasks = [
      makeTask({ id: "FN-BLOCKER", column: "triage", priority: "normal" }),
      makeTask({
        id: "FN-OLDER-URGENT",
        column: "todo",
        priority: "urgent",
        dependencies: ["FN-BLOCKER"],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeTask({ id: "FN-READY-NORMAL", column: "todo", priority: "normal", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    // Limit 1 and no in-progress occupant: only the dispatchable held peer may take this slot.
    const store = createStore(tasks, {}, { maxConcurrent: 1 });
    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-READY-NORMAL", "in-progress", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-OLDER-URGENT", "in-progress", expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-OLDER-URGENT", { status: "queued", blockedBy: "FN-BLOCKER" });
  });

  it("does not let an older urgent task blocked by an active lease starve disjoint work", async () => {
    const tasks = [
      makeTask({ id: "FN-LEASE-HOLDER", column: "in-progress", priority: "normal" }),
      makeTask({ id: "FN-OLDER-URGENT", column: "todo", priority: "urgent", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-READY-NORMAL", column: "todo", priority: "normal", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    // Limit 2: the in-progress lease holder occupies one slot, leaving one for the disjoint candidate.
    const store = createStore(tasks, {
      "FN-LEASE-HOLDER": ["packages/engine/src/scheduler.ts"],
      "FN-OLDER-URGENT": ["packages/engine/src/scheduler.ts"],
      "FN-READY-NORMAL": ["packages/core/src/store.ts"],
    }, { maxConcurrent: 2 });
    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-READY-NORMAL", "in-progress", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-OLDER-URGENT", "in-progress", expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-OLDER-URGENT", {
      status: "queued",
      blockedBy: null,
      overlapBlockedBy: "FN-LEASE-HOLDER",
    });
  });

  it("lets the older same-priority overlapping peer claim the only empty slot", async () => {
    const tasks = [
      makeTask({ id: "FN-NEWER", column: "todo", priority: "normal", createdAt: "2026-01-02T00:00:00.000Z" }),
      makeTask({ id: "FN-OLDER", column: "todo", priority: "normal", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    // Limit 1 with zero in-progress occupants: the two overlapping holds compete for exactly one slot.
    const store = createStore(tasks, {
      "FN-OLDER": ["packages/engine/src/scheduler.ts"],
      "FN-NEWER": ["packages/engine/src/scheduler.ts"],
    }, { maxConcurrent: 1 });
    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith("FN-OLDER", "in-progress", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-NEWER", "in-progress", expect.anything());
  });

  it("clears an absent overlap blocker only after confirming no current overlap remains", async () => {
    const tasks = [
      makeTask({ id: "FN-901", column: "todo", status: "queued", priority: "normal", overlapBlockedBy: "FN-MISSING" }),
    ];
    const store = createStore(tasks, {
      "FN-901": ["packages/engine/src/scheduler.ts"],
    });

    const scheduler = new Scheduler(store);
    (scheduler as any).running = true;
    await scheduler.schedule();

    expect(store.updateTask).toHaveBeenCalledWith("FN-901", { overlapBlockedBy: null });
    expect(store.moveTask).toHaveBeenCalledWith("FN-901", "in-progress", expect.anything());
  });

});
