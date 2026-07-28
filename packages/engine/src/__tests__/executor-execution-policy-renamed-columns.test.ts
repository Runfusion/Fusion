/*
FNXC:WorkflowExecutionOwnership 2026-07-28-09:10 (U8 / R3, R12 — workflow-owned lifecycle):

`handleGraphFailure`'s execution-policy ladder — the FN-7863/FN-7926 dispatch-loop gate, the
FN-7996 tool-failure retry, and the FN-7998 escalation — decided a task's own lifecycle by
naming `"todo"` and `"in-progress"` literally, at 8 sites. U5b converted the executor's
*rebounds* to `resolveReboundColumnFor` and these were left behind, each sitting somewhere an
awaited resolver could not reach: inside synchronous `updateTaskAtomic` mutators, inside
fire-and-forget resume closures, and in conditions evaluated before any resolution happened.

THE SEVERE ONE IS THE WIP GATE, and it is severe in the silent direction. `if (live.column !==
"in-progress")` classifies the run as "task already advanced — no further action needed". Under
a renamed implementation column that is true of a card sitting in its OWN wip column, so the
graph failure was swallowed whole: no terminal park, no status, no error, nothing on the board —
and the scheduler re-dispatched the same doomed run. Every downstream branch is behind that
gate, which is why the tool-failure retry, the escalation, and the bounded terminalization were
all unreachable rather than merely mistargeted. It is exactly the failure the program's problem
frame predicts: a guard that stops matching disables a recovery path invisibly and the suite
stays green.

Two further sites misbehave once the gate is passable:

  - FN-7998 escalation, node-target branch, wrote `column: "todo"` inside the atomic claim.
    Under a workflow with no `todo` column that parks the card where no workflow declares it —
    on the plan's "Stop implementation if" list, and what R7 exists to clean up after.
  - FN-7863/FN-7926's `live.column === "todo"` arm is the classic guard that stops matching.
    In-process the `executeNodeSelfRequeued` marker covers the same case, so a renamed workflow
    degrades only on the DURABLE arm — after a restart, or for a second TaskExecutor instance in
    the process, where the column read is the only evidence the inner executor requeued. A
    progressing card then falls through to the terminal sink and is parked `failed`.

Every test here was written against the literal implementation and observed FAILING first
(counts in the PR). The default-workflow and unresolvable-workflow cases are the regression
floor: `builtin:coding` resolves hold -> `todo` and wip -> `in-progress`, and an unresolvable
workflow keeps the legacy literals, so both must be byte-identical after the conversion.

Roles resolve through U1's `resolveTaskLifecycleColumns` (first column carrying each trait) —
not a new rule.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-07-28T00:00:00.000Z";
const WF = "custom:renamed";

/** A workflow whose hold column is `drafting` and whose wip column is `building`. No `todo`. */
function renamedIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "inbox", label: "Inbox", traits: [{ trait: "intake" }] },
      { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** The builtin coding shape — the byte-identical regression floor. */
function defaultIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "triage", label: "Triage", traits: [{ trait: "intake" }] },
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-U8-COL",
    title: "Execution policy column vocabulary",
    description: "renamed-column coverage for the execution-policy branches",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "in-progress" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-u8-col",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-u8-col",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    toolFailureDetectorLogCursor: 0,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

/**
 * `ir: undefined` models a workflow that cannot be resolved at all — the conservative path,
 * which must keep the pre-conversion literal so a rebound is never stranded.
 */
function harness(options: {
  ir: WorkflowIr | undefined;
  task?: Partial<TaskDetail>;
  settings?: Record<string, unknown>;
  entries?: Array<{ type: string }>;
}) {
  const store = createMockStore();
  const task = makeTask(options.task);
  const selection = { workflowId: WF, stepIds: [] };
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    autoMerge: true,
    executorToolFailureRetryCount: 2,
    executorToolFailureRetryBackoffMs: 0,
    executorToolFailureThreshold: 3,
    ...options.settings,
  });
  const entries = options.entries ?? [];
  store.getAgentLogCount = vi.fn().mockResolvedValue(entries.length);
  store.getAgentLogs = vi.fn().mockResolvedValue(entries);
  store.claimNextToolFailureRetry = vi.fn().mockResolvedValue({ outcome: "exhausted" });
  store.markToolFailureRetryExhaustedAudit = vi.fn().mockResolvedValue(true);
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  store.getTaskWorkflowSelection = vi.fn(() => selection);
  store.getTaskWorkflowSelectionAsync = vi.fn(async () => selection);
  store.getWorkflowDefinition = vi.fn(async () => (options.ir ? { id: WF, ir: options.ir } : null));
  store.updateTask.mockImplementation(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(task, patch));
  store.updateTaskAtomic = vi.fn(async (_id: string, updater: (current: TaskDetail) => Partial<TaskDetail> | null) => {
    const updates = updater(task);
    if (updates) Object.assign(task, updates);
    return task;
  });
  const executor = new TaskExecutor(store, "/tmp/test");
  (executor as any).graphToolFailureRunCursors.set(task.id, 0);
  return { executor, store, task };
}

const TOOL_ERRORS = [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }];

function stepExecuteFailure() {
  return {
    disposition: "failed" as const,
    outcome: "failure" as const,
    visitedNodeIds: ["steps#0:step-execute"],
    context: { "node:steps#0:step-execute:value": "failure" },
  };
}

function executeNodeFailure() {
  return {
    disposition: "failed" as const,
    outcome: "failure" as const,
    visitedNodeIds: ["execute"],
    context: { "node:execute:value": "recoverable" },
  };
}

describe("FN-7998 node escalation targets the workflow's own hold column", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("requeues a node escalation to the RENAMED hold column, not the literal todo", async () => {
    const { executor, task } = harness({
      ir: renamedIr(),
      task: { column: "building" },
      settings: { executorModelEscalationEnabled: true, executorEscalationNodeId: "cursor-node" },
      entries: TOOL_ERRORS,
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    /* The failure this pins: the escalated card was parked in a column id the workflow does not
       declare, so nothing on the board could route it and the node escalation never ran. */
    expect(task).toMatchObject({
      nodeId: "cursor-node",
      column: "drafting",
      executorEscalationAttempted: true,
      status: null,
      error: null,
    });
  });

  it("keeps the literal todo for the default coding workflow (regression floor)", async () => {
    const { executor, task } = harness({
      ir: defaultIr(),
      settings: { executorModelEscalationEnabled: true, executorEscalationNodeId: "cursor-node" },
      entries: TOOL_ERRORS,
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task).toMatchObject({ nodeId: "cursor-node", column: "todo", executorEscalationAttempted: true });
  });

  it("keeps the literal todo when the workflow cannot be resolved", async () => {
    const { executor, task } = harness({
      ir: undefined,
      settings: { executorModelEscalationEnabled: true, executorEscalationNodeId: "cursor-node" },
      entries: TOOL_ERRORS,
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());

    expect(task).toMatchObject({ nodeId: "cursor-node", column: "todo" });
  });

  it("still does not move the card for a MODEL-target escalation", async () => {
    /* Only the node target requeues; a model escalation retries in place. Resolving the hold
       column must not turn the model path into a move. */
    const { executor, task } = harness({
      ir: renamedIr(),
      task: { column: "building" },
      settings: {
        executorModelEscalationEnabled: true,
        executorEscalationProvider: "anthropic",
        executorEscalationModelId: "claude-sonnet",
      },
      entries: TOOL_ERRORS,
    });

    await (executor as any).handleGraphFailure(task, stepExecuteFailure());
    await vi.advanceTimersByTimeAsync(0);

    expect(task).toMatchObject({ modelProvider: "anthropic", modelId: "claude-sonnet", column: "building" });
  });
});

describe("FN-7863/FN-7926 dispatch-loop gate matches the workflow's own hold column", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("recognises an inner-executor requeue that landed in the RENAMED hold column", async () => {
    /*
    No in-process `executeNodeSelfRequeued` marker: this is the durable arm of the guard, the
    one that survives a restart and is the ONLY evidence available to a second TaskExecutor
    instance. Before the conversion the column read did not match, the run fell through to the
    terminal sink, and a progressing card was parked failed.
    */
    const { executor, store, task } = harness({ ir: renamedIr(), task: { column: "drafting" } });

    await (executor as any).handleGraphFailure(task, executeNodeFailure());

    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("executor recovery preserved"),
      undefined,
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  it("still recognises the default workflow's todo (regression floor)", async () => {
    const { executor, store, task } = harness({ ir: defaultIr(), task: { column: "todo" } });

    await (executor as any).handleGraphFailure(task, executeNodeFailure());

    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("executor recovery preserved"),
      undefined,
      undefined,
    );
  });

  it("does NOT fire for a card sitting in the workflow's wip column", async () => {
    /*
    The guard must stay narrow. A card still in the implementation column with no self-requeue
    marker is a genuine execute failure and belongs to the terminal sink — widening the gate to
    "any column" would swallow real failures as benign recoveries.
    */
    const { executor, store, task } = harness({ ir: renamedIr(), task: { column: "building" } });

    await (executor as any).handleGraphFailure(task, executeNodeFailure());

    expect(store.logEntry).not.toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("executor recovery preserved"),
      undefined,
      undefined,
    );
  });

  it("still honours the in-process self-requeue marker when the workflow cannot be resolved", async () => {
    const { executor, store, task } = harness({ ir: undefined, task: { column: "in-progress" } });
    /* markGraphExecuteSelfRequeued only records while the task is graph-routed. */
    (executor as any).graphRouting.add(task.id);
    (executor as any).markGraphExecuteSelfRequeued(task.id);
    try {
      await (executor as any).handleGraphFailure(task, executeNodeFailure());
    } finally {
      (executor as any).graphRouting.delete(task.id);
    }

    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("executor recovery preserved"),
      undefined,
      undefined,
    );
  });
});
