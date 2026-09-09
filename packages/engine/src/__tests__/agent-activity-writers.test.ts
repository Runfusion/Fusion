import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isTerminalStepResult } from "@fusion/core";
import { queryAgentActivityEvents } from "../../../core/src/task-store/async/async-agent-activity.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { TaskExecutor, resolveWorkflowGateActivityClaim } from "../executor.js";
import { completeTask } from "../merger.js";
import { SelfHealingManager } from "../self-healing.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import "./executor-test-helpers.js";

/*
FNXC:AgentActivityStream 2026-08-09-12:59:
Drive the executor's review-handoff choke point rather than a copied helper. The store facade is
its production seam, so this guards the event against a future refactor that only wires test-only
or optional core-store dependencies.
*/
describe("engine agent activity writers", () => {
  it("prefers the routed workflow reviewer over the task assignee for gate attribution", () => {
    const claim = resolveWorkflowGateActivityClaim("agent-reviewer", "agent-assignee");

    expect(claim.agentId).toBe("agent-reviewer");
    expect(claim.claimedAttribution).toBe("agent");
  });

  it("falls back to the engine lane only when no workflow principal is available", () => {
    const claim = resolveWorkflowGateActivityClaim(undefined, undefined);

    expect(claim.agentId).toBe("executor");
    expect(claim.claimedAttribution).toBe("lane");
  });

  it("preserves a routed reviewer through the graph gate-result lifecycle", async () => {
    const task = {
      id: "FN-8864",
      assignedAgentId: "agent-assignee",
      description: "activity",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
    } as any;
    const store = {
      on: vi.fn(),
      getRootDir: vi.fn().mockReturnValue("/repo"),
      getTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn().mockResolvedValue(task),
      getSettings: vi.fn().mockResolvedValue({ experimentalFeatures: { workflowGraphExecutor: true } }),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "WF-activity", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({
        id: "WF-activity",
        ir: { version: "v1", name: "Activity", nodes: [], edges: [] },
      }),
      listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([]),
      recordAgentActivity: vi.fn().mockResolvedValue({ seq: "1" }),
    } as any;
    const agentStore = {
      workflowProjectId: "/repo",
      acquireWorkflowSessionCapacity: vi.fn().mockResolvedValue("acquired"),
      releaseWorkflowSessionCapacity: vi.fn().mockResolvedValue(undefined),
      listAgents: vi.fn().mockResolvedValue([
        { id: "agent-assignee", state: "active", roles: ["executor"] },
        { id: "agent-reviewer", state: "active", roles: ["reviewer"] },
      ]),
    };
    const executor = new TaskExecutor(store, "/repo", { agentStore: agentStore as any });
    let preflightResult: unknown;
    let terminalResult = false;
    let lifecycleError: unknown;
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockImplementation(async function (_task, _settings, _startNode, context) {
      try {
        const graphContext = context ?? {};
        const node = {
          id: "code-review",
          kind: "prompt",
          reviewerAgentId: "agent-reviewer",
          config: { workflowRole: "reviewer" },
        } as any;
        preflightResult = await (this as any).deps.beforeNodeExecution(node, task, graphContext);
        if (preflightResult) return { disposition: "suspended", outcome: "failure", visitedNodeIds: [] } as any;
        const result = {
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "passed",
          startedAt: "2026-08-09T13:43:00.000Z",
          completedAt: "2026-08-09T13:44:00.000Z",
        };
        terminalResult = isTerminalStepResult(result);
        /*
        FNXC:AgentActivityStream 2026-08-09-13:59:
        Reproduce production ordering: the graph releases its per-attempt principal before the
        terminal lifecycle sink, so attribution must survive outside the live-principal map.
        */
        (graphContext["workflow:release-principal"] as (() => void) | undefined)?.();
        await (this as any).deps.recordWorkflowStepResult(task.id, result);
        return { disposition: "completed", outcome: "success", visitedNodeIds: ["code-review"] } as any;
      } catch (error) {
        lifecycleError = error;
        return { disposition: "failed", outcome: "failure", visitedNodeIds: [] } as any;
      }
    });

    try {
      expect((executor as any).store.recordAgentActivity).toBe(store.recordAgentActivity);
      await (executor as any).executeWorkflowGraph(task);
      expect(run).toHaveBeenCalledTimes(1);
      expect(preflightResult).toBeUndefined();
      expect(lifecycleError).toBeUndefined();
      expect(terminalResult).toBe(true);
      expect(store.recordAgentActivity).toHaveBeenCalledWith(expect.objectContaining({
        type: "workflow:gate-passed",
        attributionClaim: expect.objectContaining({ agentId: "agent-reviewer", claimedAttribution: "agent" }),
        taskId: "FN-8864",
      }));
    } finally {
      run.mockRestore();
    }
  });

  it("gives workflow-gate retries distinct durable identities and ordinals", async () => {
    const task = {
      id: "FN-8864",
      assignedAgentId: "agent-reviewer",
      description: "activity",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      workflowStepResults: [],
    } as any;
    const store = {
      on: vi.fn(),
      getRootDir: vi.fn().mockReturnValue("/repo"),
      getTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn().mockImplementation(async (_taskId, patch) => {
        Object.assign(task, patch);
        return task;
      }),
      getSettings: vi.fn().mockResolvedValue({ experimentalFeatures: { workflowGraphExecutor: true } }),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "WF-activity", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "WF-activity", ir: { version: "v1", name: "Activity", nodes: [], edges: [] } }),
      listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([]),
      recordAgentActivity: vi.fn().mockResolvedValue({ seq: "1" }),
    } as any;
    const executor = new TaskExecutor(store, "/repo", {
      agentStore: {
        workflowProjectId: "/repo",
        acquireWorkflowSessionCapacity: vi.fn().mockResolvedValue("acquired"),
        releaseWorkflowSessionCapacity: vi.fn().mockResolvedValue(undefined),
        listAgents: vi.fn().mockResolvedValue([{ id: "agent-reviewer", state: "active", roles: ["reviewer"] }]),
      } as any,
    });
    let runCount = 0;
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockImplementation(async function (_task, _settings, _startNode, context) {
      runCount++;
      const startedAt = `2026-08-09T14:2${runCount}:00.000Z`;
      await (this as any).deps.recordWorkflowStepResult(task.id, {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "failed",
        startedAt,
        completedAt: `2026-08-09T14:2${runCount}:01.000Z`,
      });
      return { disposition: "completed", outcome: "failure", visitedNodeIds: ["code-review"] } as any;
    });

    try {
      // Exceed the bounded five-entry history. The durable identity must still retain every
      // later retry rather than reusing the capped priorAttempts length.
      for (let attempt = 0; attempt < 7; attempt++) {
        await (executor as any).executeWorkflowGraph(task);
      }

      expect(task.workflowStepResults[0]?.priorAttempts).toHaveLength(5);
      const gateEvents = store.recordAgentActivity.mock.calls
        .map(([input]: [any]) => input)
        .filter((input: any) => input.type === "workflow:gate-failed");
      expect(gateEvents).toHaveLength(7);
      expect(gateEvents.map((input: any) => input.discriminator)).toEqual([
        "code-review:2026-08-09T14:21:00.000Z",
        "code-review:2026-08-09T14:22:00.000Z",
        "code-review:2026-08-09T14:23:00.000Z",
        "code-review:2026-08-09T14:24:00.000Z",
        "code-review:2026-08-09T14:25:00.000Z",
        "code-review:2026-08-09T14:26:00.000Z",
        "code-review:2026-08-09T14:27:00.000Z",
      ]);
    } finally {
      run.mockRestore();
    }
  });

  it("deduplicates replayed self-healing handoffs on the durable handoff transition", async () => {
    const task = {
      id: "FN-8864",
      assignedAgentId: "agent-deadbeef",
      column: "in-review",
      updatedAt: "2026-08-09T14:07:00.000Z",
      autoMerge: true,
    } as any;
    const store = {
      handoffToReview: vi.fn().mockResolvedValue(task),
      getSettings: vi.fn().mockResolvedValue({}),
      recordAgentActivity: vi.fn().mockResolvedValue({ seq: "1" }),
    } as any;
    const manager = new SelfHealingManager(store, { rootDir: "/repo" });

    try {
      await (manager as any).handoffTaskToReview(task.id, "stuck-no-progress-churn");
      await (manager as any).handoffTaskToReview(task.id, "stuck-no-progress-churn");

      expect(store.recordAgentActivity).toHaveBeenCalledTimes(2);
      const [first, replay] = store.recordAgentActivity.mock.calls.map(([input]: [any]) => input);
      expect(first).toEqual(expect.objectContaining({
        type: "task:handed-off",
        taskId: task.id,
        discriminator: "2026-08-09T14:07:00.000Z:stuck-no-progress-churn",
        metadata: expect.objectContaining({ source: "self-healing", reason: "stuck-no-progress-churn" }),
      }));
      expect(replay.discriminator).toBe(first.discriminator);
    } finally {
      manager.stop();
    }
  });

  it("records one handoff event after the real handoff transition", async () => {
    const task = { id: "FN-8864", assignedAgentId: "agent-deadbeef", description: "activity", column: "in-progress", dependencies: [], steps: [], currentStep: 0 } as any;
    const store = {
      on: vi.fn(),
      handoffToReview: vi.fn().mockResolvedValue({ ...task, column: "in-review" }),
      getSettings: vi.fn().mockResolvedValue({}),
      recordAgentActivity: vi.fn().mockResolvedValue({ seq: "1" }),
    } as any;
    const executor = new TaskExecutor(store, "/repo");

    await (executor as any).handoffTaskToReview(task, "review-handoff-requested", "exec-FN-8864-1234567890-abcd");

    expect(store.handoffToReview).toHaveBeenCalledWith("FN-8864", expect.any(Object));
    expect(store.recordAgentActivity).toHaveBeenCalledTimes(1);
    expect(store.recordAgentActivity).toHaveBeenCalledWith(expect.objectContaining({
      type: "task:handed-off",
      taskId: "FN-8864",
      discriminator: "exec-FN-8864-1234567890-abcd:review-handoff-requested",
      metadata: { runId: "exec-FN-8864-1234567890-abcd", reason: "review-handoff-requested", source: "executor" },
    }));
  });
});

/*
FNXC:AgentActivityStream 2026-08-09-19:03:
The engine owns handoff production wiring but reaches the outbox through TaskStore. Exercise that
real facade against PostgreSQL so a mocked recordAgentActivity method cannot masquerade as durable
writer coverage.
*/
pgDescribe("engine agent activity durable writer", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_engine_agent_activity",
    projectId: "proj_engine_agent_activity",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  FNXC:AgentActivityStream 2026-08-09-21:19:
  Task start is emitted inside the executor's real implementation phase, not graph routing.
  Stop at its normal unmet-dependency exit immediately after startup so this PostgreSQL test proves
  the production run-context choke point without starting an agent or creating a worktree.
  */
  it("persists task start from the real executor implementation path", async () => {
    const task = await h.createTestTask();
    const liveTask = {
      ...await h.store().moveTask(task.id, "in-progress", { moveSource: "agent" }),
      dependencies: ["FN-blocking-activity"],
    } as any;
    const store = Object.assign(Object.create(h.store()), {
      listTasks: vi.fn().mockResolvedValue([{ id: "FN-blocking-activity", column: "todo" }]),
    }) as any;
    const executor = new TaskExecutor(store, h.rootDir());
    const workEngine = vi.spyOn(executor as any, "maybeDispatchWorkflowWorkEngine").mockResolvedValue(false);

    try {
      await (executor as any).runImplementation(liveTask, vi.fn());
    } finally {
      workEngine.mockRestore();
      /*
      FNXC:AgentActivityStream 2026-08-09-21:19:
      Constructor listeners are production lifecycle resources; remove them in this direct
      implementation-path test so the shared harness cannot retain a stale executor.
      */
      (executor as any).unregisterTaskMoveDisposer?.();
    }

    const { events } = await queryAgentActivityEvents(h.layer(), { taskId: task.id, type: "task:started" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task:started",
      taskId: task.id,
      agentId: "executor",
      agentAttribution: "lane",
    });
    expect(events[0]?.metadata?.runId).toMatch(/^exec-/);
  });

  it("persists the real executor review handoff through TaskStore", async () => {
    const task = await h.createTestTask();
    const executableTask = await h.store().moveTask(task.id, "in-progress", { moveSource: "agent" });
    const executor = new TaskExecutor(h.store(), h.rootDir());

    await (executor as any).handoffTaskToReview(executableTask, "review-handoff-requested", "exec-KB-001-1234567890-abcd");

    const { events } = await queryAgentActivityEvents(h.layer(), { taskId: task.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task:handed-off",
      taskId: task.id,
      agentId: "executor",
      agentAttribution: "lane",
      metadata: {
        runId: "exec-KB-001-1234567890-abcd",
        reason: "review-handoff-requested",
        source: "executor",
      },
    });
  });

  it("persists a terminal graph gate through the production TaskStore outbox facade", async () => {
    const task = await h.createTestTask();
    const liveTask = {
      ...task,
      assignedAgentId: undefined,
      workflowStepResults: [],
      column: "in-progress",
    } as any;
    /*
    FNXC:AgentActivityStream 2026-08-09-19:21:
    Keep graph-routing dependencies narrow, but inherit recordAgentActivity from the live
    PostgreSQL TaskStore. This proves the terminal sink reaches the durable outbox rather than
    only satisfying a mocked facade expectation.
    */
    const store = Object.assign(Object.create(h.store()), {
      on: vi.fn(),
      getRootDir: vi.fn().mockReturnValue(h.rootDir()),
      getTask: vi.fn().mockResolvedValue(liveTask),
      updateTask: vi.fn().mockImplementation(async (_taskId: string, patch: object) => {
        Object.assign(liveTask, patch);
        return liveTask;
      }),
      getSettings: vi.fn().mockResolvedValue({ experimentalFeatures: { workflowGraphExecutor: true } }),
      getTaskWorkflowSelectionAsync: vi.fn().mockResolvedValue({ workflowId: "WF-activity", stepIds: [] }),
      getWorkflowDefinition: vi.fn().mockResolvedValue({ id: "WF-activity", ir: { version: "v1", name: "Activity", nodes: [], edges: [] } }),
      listWorkflowWorkItemsForTask: vi.fn().mockResolvedValue([]),
    }) as any;
    const executor = new TaskExecutor(store, h.rootDir());
    const run = vi.spyOn(WorkflowGraphTaskRunner.prototype, "run").mockImplementation(async function (_task, _settings, _startNode, context) {
      await (this as any).deps.recordWorkflowStepResult(task.id, {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "passed",
        startedAt: "2026-08-09T20:16:00.000Z",
        completedAt: "2026-08-09T20:16:01.000Z",
      });
      return { disposition: "completed", outcome: "success", visitedNodeIds: ["code-review"] } as any;
    });

    try {
      await (executor as any).executeWorkflowGraph(liveTask);
    } finally {
      run.mockRestore();
    }

    const { events } = await queryAgentActivityEvents(h.layer(), { taskId: task.id, type: "workflow:gate-passed" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "workflow:gate-passed",
      agentId: "executor",
      agentAttribution: "lane",
      taskId: task.id,
      metadata: { stepId: "code-review", status: "passed", attempt: 0 },
    });
  });

  /*
  FNXC:AgentActivityStream 2026-08-09-21:19:
  Completion is the merger's shared finalization sink for every successful merge path. Export the
  narrow orchestration seam so this PostgreSQL test can prove its real durable write without
  simulating git, network, or an AI merge session.
  */
  it("persists task completion through the merger finalization path", async () => {
    const task = await h.createTestTask();
    /* FNXC:RequiredPreMergeSteps 2026-08-23-00:20: this asserts agent-activity persistence on
       completion, not review gating. The shared harness task carries the workflow's default-on
       optional groups with no results, so the done-transition door refused it before the writer
       under test ran. Declaring no optional gates states this fixture's intent. */
    await h.store().updateTask(task.id, { enabledWorkflowSteps: [] });
    const settings = await h.store().getSettings();
    await h.store().moveTask(task.id, "in-progress", { moveSource: "agent" });
    await h.store().moveTask(task.id, "in-review", { moveSource: "agent" });

    await completeTask(h.store(), task.id, { merged: true, commitSha: "a".repeat(40) } as any);

    const { events } = await queryAgentActivityEvents(h.layer(), { taskId: task.id, type: "task:completed" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task:completed",
      taskId: task.id,
      agentId: "merger",
      agentAttribution: "lane",
      metadata: { sha: "a".repeat(40), strategy: settings.mergeStrategy },
    });
  });

  it("persists a self-healing review handoff through the production outbox facade", async () => {
    const task = await h.createTestTask();
    const store = Object.assign(Object.create(h.store()), {
      /*
      FNXC:AgentActivityStream 2026-08-09-21:19:
      The transition itself is covered by focused self-healing tests. Avoid scheduling its unrelated
      asynchronous merge-worktree follow-up here; recordAgentActivity remains the real PostgreSQL
      facade this production writer must use.
      */
      handoffToReview: vi.fn().mockResolvedValue({ ...task, column: "in-review" }),
    }) as any;
    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });

    try {
      await (manager as any).handoffTaskToReview(task.id, "completed-task-recovered");
    } finally {
      manager.stop();
    }

    const { events } = await queryAgentActivityEvents(h.layer(), { taskId: task.id, type: "task:handed-off" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: "executor",
      agentAttribution: "lane",
      metadata: { reason: "completed-task-recovered", source: "self-healing" },
    });
  });
});
