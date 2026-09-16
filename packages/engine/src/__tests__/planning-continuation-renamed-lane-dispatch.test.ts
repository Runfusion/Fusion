/*
FNXC:WorkflowLifecycleColumns 2026-09-16-05:30 (PR #3615 review, finding 1):
The dispatch-site fix — threading `resolveTaskLifecycleColumns` into
`isPlanningContinuationTaskDispatchable` inside `dispatchPlanningContinuationIfCurrent` — had only
pure-predicate coverage (`planning-continuation-terminal-lanes.test.ts`). The predicate accepting a
set is not the shipped behavior; the shipped behavior is THAT SET BEING BUILT FROM THE TASK'S OWN
BOARD at this call site. A regression here reverts silently: the predicate still passes every
existing unit test while a renamed board's COMPLETE card is admitted to plan-review again.

So this is the behavioral pair the review asked for: drive the exported admission entry point
(`admitPlanningContinuation`, which routes through `dispatchPlanningContinuationIfCurrent` on both
the same-slot-handoff and coordinator-drain branches) against a fake store whose workflow declares
a RENAMED vocabulary, and assert admission follows the renamed lane — card in the renamed COMPLETE
lane is NOT admitted, card in a mid-board lane IS admitted. With the fix reverted, the first case
admits (terminal check falls back to `done`), and the pair goes red.

The store deliberately resolves the selection (no throw path): an unresolvable workflow degrades to
the built-in IR and would make both cases exercise only the legacy fallback.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

import { projectAdmissionCoordinator } from "../concurrency/concurrency.js";
import { admitPlanningContinuation } from "../runtimes/in-process-runtime.js";
import { lifecycleIr, RENAMED_VOCAB } from "./_workflow-vocabulary-fixture.js";

const PROJECT_ID = "/test/planning-continuation-renamed-lane";
const WORKFLOW_ID = "custom:renamed-dispatch-probe";

/** The continuation row under admission. `dispatchPlanningContinuationIfCurrent` compares the
 *  re-read item against this object field-by-field, so the fake store must echo THIS object. */
function planningItem(taskId: string): WorkflowWorkItem {
  return {
    id: `continuation-${taskId}`,
    taskId,
    nodeId: "plan-review",
    kind: "task",
    state: "runnable",
    waitReason: "planning",
    createdAt: "2026-09-16T05:30:00.000Z",
  } as unknown as WorkflowWorkItem;
}

function task(id: string, column: string): Task {
  return {
    id,
    title: id,
    description: id,
    column,
    priority: "medium",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-16T05:30:00.000Z",
    updatedAt: "2026-09-16T05:30:00.000Z",
  } as Task;
}

/**
 * A capacity-generous fake store that resolves ONE task onto a renamed-vocabulary workflow.
 * `listTasks` stays empty so the coordinator's admission snapshot counts zero active cards —
 * a refusal can then only come from the terminal/approval guards, not from capacity.
 */
function renamedBoardStore(card: Task, item: WorkflowWorkItem): TaskStore {
  return {
    getSettings: vi.fn(async () => ({ maxConcurrent: 12, maxWorktrees: 9, worktreeLimitEnabled: true })),
    listTasks: vi.fn(async () => [] as Task[]),
    getTask: vi.fn(async (taskId: string) => (taskId === card.id ? card : undefined)),
    getWorkflowWorkItem: vi.fn(async (itemId: string) => (itemId === item.id ? item : null)),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: WORKFLOW_ID })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: WORKFLOW_ID })),
    getWorkflowDefinition: vi.fn(async (id: string) =>
      id === WORKFLOW_ID ? { ir: lifecycleIr(RENAMED_VOCAB, WORKFLOW_ID) } : undefined),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
}

afterEach(() => {
  projectAdmissionCoordinator.releaseReservation("FN-RENAMED-COMPLETE");
  projectAdmissionCoordinator.releaseReservation("FN-RENAMED-MIDBOARD");
});

describe("planning-continuation admission resolves terminal columns from the task's board", () => {
  it("does NOT admit a continuation for a card sitting in the renamed COMPLETE lane", async () => {
    const dispatch = vi.fn(async () => {});
    const card = task("FN-RENAMED-COMPLETE", RENAMED_VOCAB.complete);
    const item = planningItem(card.id);

    const admitted = await admitPlanningContinuation({
      store: renamedBoardStore(card, item),
      projectId: PROJECT_ID,
      task: card,
      item,
      dispatch,
    });

    // `admitPlanningContinuation` answers "item ownership taken", not "dispatcher ran";
    // the shipped behavior under test is the dispatcher call itself.
    void admitted;
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("admits the same continuation while the card is in a non-terminal lane of that board", async () => {
    const dispatch = vi.fn(async () => {});
    const card = task("FN-RENAMED-MIDBOARD", RENAMED_VOCAB.wip);
    const item = planningItem(card.id);

    const admitted = await admitPlanningContinuation({
      store: renamedBoardStore(card, item),
      projectId: PROJECT_ID,
      task: card,
      item,
      dispatch,
    });

    expect(admitted).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
