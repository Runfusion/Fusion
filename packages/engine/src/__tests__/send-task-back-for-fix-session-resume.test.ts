import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

import { sendTaskBackForFix } from "../executor/send-task-back-for-fix.js";

/*
FNXC:SessionResume 2026-08-10-17:33:
The remediation bounce used to null `sessionFile` unconditionally, so every review round-trip restarted
the implementation agent cold — it re-read the repository and re-derived the change it had just written,
once per round. Combined with unbounded review remediation that was the dominant cost of task wall-clock.
These pin the contract that `preserveResumeState` preserves the CONVERSATION, and that a caller which
explicitly opts out still gets a cold session.
*/

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-RESUME",
    worktree: "/tmp/fusion/fn-resume",
    sessionFile: "/tmp/fusion/fn-resume/.session.jsonl",
    ...overrides,
  } as Task;
}

function createDeps(live: Task) {
  const store = {
    addTaskComment: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(live),
    getSettings: vi.fn().mockResolvedValue({}),
  };
  return {
    store: store as never,
    getRunContextFor: () => undefined,
    clearCompletedTaskWatchdog: vi.fn(),
    injectWorkflowStepFailureInstructions: vi.fn().mockResolvedValue(undefined),
    reopenLastStepForRevision: vi.fn().mockResolvedValue(undefined),
    scheduleWorkflowRerun: vi.fn(),
    maxWorkflowStepRetries: 3,
    _store: store,
  };
}

function sessionFilePatches(store: { updateTask: ReturnType<typeof vi.fn> }) {
  return store.updateTask.mock.calls
    .map(([, patch]) => patch)
    .filter((patch: Record<string, unknown>) => patch && "sessionFile" in patch);
}

describe("sendTaskBackForFix session preservation", () => {
  it("preserves sessionFile so a remediation round continues the implementation conversation", async () => {
    const live = task();
    const deps = createDeps(live);

    await sendTaskBackForFix(deps as never, live, live.worktree!, "fix it", "Code Review", "revision requested", true);

    // No patch may null the session — that is what forced a cold restart every round.
    expect(sessionFilePatches(deps._store)).toEqual([]);
    const statusPatch = deps._store.updateTask.mock.calls.find(([, patch]) => patch && "workflowStepRetries" in patch);
    expect(statusPatch?.[1]).toEqual({ status: null, error: null, workflowStepRetries: 0 });
  });

  it("still clears sessionFile when the caller explicitly opts out of resume state", async () => {
    const live = task();
    const deps = createDeps(live);

    await sendTaskBackForFix(deps as never, live, live.worktree!, "fix it", "Code Review", "revision requested", false);

    expect(sessionFilePatches(deps._store)).toEqual([
      { sessionFile: null, status: null, error: null, workflowStepRetries: 0 },
    ]);
  });

  it("forwards structured findings to the PROMPT.md injection", async () => {
    const live = task();
    const deps = createDeps(live);
    const findings = [{ id: "a", title: "t", body: "b", severity: "critical" as const }];

    await sendTaskBackForFix(
      deps as never,
      live,
      live.worktree!,
      "fix it",
      "Code Review",
      "revision requested",
      true,
      false,
      { attempt: 1, max: 3 },
      findings,
    );

    expect(deps.injectWorkflowStepFailureInstructions).toHaveBeenCalledWith(
      live,
      "fix it",
      "Code Review",
      { attempt: 1, max: 3 },
      findings,
    );
  });
});
