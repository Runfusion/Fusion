import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

/*
FNXC:ManualMergeDeadlock 2026-10-12-09:43 (operator-authorized, found auditing what the restarts stranded):
Original symptom: `ALFA-007` reached the `done` lane still carrying `status: "merging"` and stayed that way
for 33 days across four engine restarts, because the startup clear read ONLY the review-role lanes.
`getTaskMergeBlocker` treats that status as merge-active and `isMergePending` refuses finalization on it, so
the identical leftover on a card that stayed in a review lane would have blocked its manual merge forever —
there is no other recovery path for a status no sweep reads.

Assertion below is the invariant, not the repro: the clear is lane-agnostic across every live lane, keeps
clearing the review-lane case it always handled, leaves non-merge statuses alone, and never SELECTs the
`log` column to do it (it reads `id` and `status` only, and `log` is the heaviest column on the board).
*/

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getTaskStore: () => null,
      getAgentStore: vi.fn(),
      getMessageStore: vi.fn(),
      getRoutineStore: vi.fn(),
      getRoutineRunner: vi.fn(),
      getHeartbeatMonitor: vi.fn(),
      getTriggerScheduler: vi.fn(),
      configurePrMonitoring: vi.fn(),
      setActiveMergeTaskIdProvider: vi.fn(),
      setActiveMergeStartedAtMsProvider: vi.fn(),
      setActiveMergeAborter: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergeActiveClearer: vi.fn(),
      setMergePendingProvider: vi.fn(),
      setMergeRequester: vi.fn(),
      resumeAfterUnpause: vi.fn(async () => undefined),
      getPluginRunner: vi.fn(() => undefined),
    };
  }),
}));

import { ProjectEngine } from "../project-engine.js";

function card(id: string, column: string, status: string | null): Task {
  return { id, column, status, paused: false, mergeRetries: 0 } as Task;
}

function makeEngine(rows: Task[]) {
  const listTasks = vi.fn(async () => rows);
  const updateTask = vi.fn(async () => undefined);
  const store = { listTasks, updateTask } as unknown as TaskStore;
  const engine = new ProjectEngine(
    {
      projectId: "proj_test",
      workingDirectory: "/tmp/proj_test",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 2,
    },
    {} as never,
    { skipNotifier: true },
  ) as unknown as { clearStaleMergingStatuses(store: TaskStore): Promise<Task[]> };
  return { engine, store, listTasks, updateTask };
}

describe("startup stale-merging clear covers every live lane", () => {
  it("clears a crash-leftover merging status on a card that is no longer in a review lane", async () => {
    const rows = [
      card("ALFA-007", "done", "merging"),
      card("R-PR", "in-review", "merging-pr"),
      card("P-STUCK", "parked", "merging"),
      card("T-BACK", "todo", "merging-pr"),
    ];
    const { engine, store, updateTask } = makeEngine(rows);

    const cleared = await engine.clearStaleMergingStatuses(store);

    expect(updateTask.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["ALFA-007", { status: null }],
      ["R-PR", { status: null }],
      ["P-STUCK", { status: null }],
      ["T-BACK", { status: null }],
    ]);
    // Callers that keep the returned rows must see the cleared value, not the stale one.
    expect(cleared.map((t) => t.status)).toEqual([null, null, null, null]);
  });

  it("leaves non-merge statuses untouched and reads the board without the log column", async () => {
    const rows = [
      card("R-OK", "in-review", "review"),
      card("R-NONE", "in-review", null),
      card("D-OK", "done", null),
      card("R-DONE", "done", "done"),
    ];
    const { engine, store, listTasks, updateTask } = makeEngine(rows);

    await engine.clearStaleMergingStatuses(store);

    expect(updateTask).not.toHaveBeenCalled();
    const options = listTasks.mock.calls[0]?.[0];
    expect(options).toEqual(expect.objectContaining({ derive: false, excludeLog: true }));
  });
});
