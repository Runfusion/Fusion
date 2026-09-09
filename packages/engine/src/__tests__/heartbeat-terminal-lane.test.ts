import { describe, expect, it, vi } from "vitest";
import { isTaskInTerminalLane } from "../agent-heartbeat.js";
import type { TaskStore, WorkflowIr } from "@fusion/core";

/*
FNXC:WorkflowLifecycleColumns 2026-08-01-07:20 (fleet — two heartbeat terminal checks):

Both call sites asked whether a task is finished, and neither is
cosmetic:

  LINKED-TASK CLEAR. The heartbeat clears an agent's assignment once its card is finished. Keyed on
  the literals, an agent on a renamed board stayed bound to a COMPLETED card indefinitely, so every
  later heartbeat ran with stale task context instead of picking up new work.

  WORKTREE-ACQUISITION GATE. Its failure bookkeeping runs only for a NON-terminal task. A card in a
  renamed complete lane read as non-terminal, so an acquisition failure could stamp
  `status: "failed"` and an error onto work that was already done. That site WRITES, which is why
  the fallback below degrades toward "terminal" rather than "unfinished".

Tested at the predicate because it IS the conversion — both call sites are one-line swaps to it. The
cases are differential: one workflow SHAPE, two vocabularies, only the ids differ, so any difference
between the runs is attributable to a surviving literal.
*/

const RENAMED_IR = {
  version: "v2",
  id: "custom:renamed-terminal",
  nodes: [],
  edges: [],
  columns: [
    { id: "drafting", label: "Drafting", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "building", label: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
    { id: "shipped", label: "Shipped", traits: [{ trait: "complete" }] },
  ],
} as unknown as WorkflowIr;

function storeFor(ir: WorkflowIr | undefined): TaskStore {
  const selection = { workflowId: "custom:renamed-terminal", stepIds: [] as string[] };
  return {
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => (ir ? selection : undefined)),
    getWorkflowDefinition: vi.fn(async () => (ir ? { ir } : undefined)),
  } as unknown as TaskStore;
}

describe("heartbeat resolves the terminal lanes from the task's own board", () => {
  it("recognises a RENAMED complete lane as terminal", async () => {
    expect(await isTaskInTerminalLane(storeFor(RENAMED_IR), { id: "FN-1", column: "shipped" })).toBe(true);
  });

  /* The paired negative, and the one that matters most: the writing call site must not fire on it. */
  it("does NOT treat an active lane as terminal", async () => {
    expect(await isTaskInTerminalLane(storeFor(RENAMED_IR), { id: "FN-1", column: "building" })).toBe(false);
    expect(await isTaskInTerminalLane(storeFor(RENAMED_IR), { id: "FN-1", column: "drafting" })).toBe(false);
  });

  /*
  A card sitting on a legacy id that the RENAMED board does not declare is NOT terminal there. This is
  the case a `terminal.has(column)`-style union would get wrong, and it is why the check compares
  against the task's own resolved lanes rather than a board-wide set.
  */
  it("does not treat a legacy id as terminal on a board that does not declare it", async () => {
    expect(await isTaskInTerminalLane(storeFor(RENAMED_IR), { id: "FN-1", column: "done" })).toBe(false);
  });

  it("falls back to Done when the workflow cannot be resolved", async () => {
    const store = storeFor(undefined);

    expect(await isTaskInTerminalLane(store, { id: "FN-1", column: "done" })).toBe(true);
    expect(await isTaskInTerminalLane(store, { id: "FN-1", column: "archived" })).toBe(false);
    expect(await isTaskInTerminalLane(store, { id: "FN-1", column: "in-progress" })).toBe(false);
  });
});
