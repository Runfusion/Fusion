import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";
import { promoteHeldTask, releaseHeldTaskByEvent, runHoldReleaseSweep } from "../execution/hold-release.js";

type Sink = undefined | (() => unknown);
const hostileSinks: [string, Sink][] = [
  ["absent", undefined],
  ["throws", () => { throw new Error("sink down"); }],
  ["rejects", () => Promise.reject(new Error("sink down"))],
  ["hangs", () => new Promise<void>(() => {})],
];

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-1", title: "held", description: "", column: "todo", status: null,
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z", ...overrides,
  } as Task;
}

function workflow(release: "dependency" | "capacity" | "external-event"): WorkflowIr {
  return {
    version: "v2", id: "wf", nodes: [], edges: [], columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release } }] },
      { id: "in-progress", label: "In progress", traits: [{ trait: "wip" }] },
      // Deliberately omit complete so legacy `done` and workflow completion disagree.
      { id: "done", label: "Done", traits: [] },
    ],
  } as unknown as WorkflowIr;
}

function storeFor(tasks: Task[], ir: WorkflowIr, recordRunAuditEvent: Sink) {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  return {
    getSettings: vi.fn(async () => ({})), listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "wf", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    updateTask: vi.fn(async () => undefined),
    moveTaskIf: vi.fn(async () => ({ moved: true })),
    recordRunAuditEvent,
  } as unknown as TaskStore;
}

async function settleAwaited(pending: Promise<unknown>, name: string) {
  if (name === "hangs") await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS);
  await expect(pending).resolves.toMatchObject({ released: true, toColumn: "in-progress" });
}

describe("hold-release run-audit sink health", () => {
  it.each(hostileSinks)("keeps the real dependency-parity sweep result unchanged when audit sink %s", async (_name, sink) => {
    const held = task({ id: "FN-1", dependencies: ["FN-2"] });
    const completedLegacyOnly = task({ id: "FN-2", column: "done" });
    const audit = sink ? vi.fn(sink) : undefined;
    const result = await runHoldReleaseSweep(storeFor([held, completedLegacyOnly], workflow("dependency"), audit), { now: () => 1 });
    expect(result.released).toEqual(["FN-1"]);
    if (audit) expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "merge:dependency-parity-diff", taskId: "FN-2",
      metadata: { depId: "FN-2", completeFlagResult: false, legacyResult: true, source: "hold-release.dependency" },
    }));
  });

  it.each(hostileSinks)("keeps force-promote observable results unchanged when audit sink %s", async (name, sink) => {
    if (name === "hangs") vi.useFakeTimers();
    try {
      const held = task({ status: "needs-replan" });
      const audit = sink ? vi.fn(sink) : undefined;
      const store = storeFor([held], workflow("capacity"), audit);
      await settleAwaited(promoteHeldTask(store, held.id, {}, { force: true }), name);
      if (audit) expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "task:promote-forced-unplanned", taskId: "FN-1", agentId: "system", runId: "promote-force-FN-1",
      }));
    } finally { vi.useRealTimers(); }
  });

  it.each(hostileSinks)("keeps event release observable results unchanged when audit sink %s", async (_name, sink) => {
    const held = task({});
    const audit = sink ? vi.fn(sink) : undefined;
    const result = await releaseHeldTaskByEvent(storeFor([held], workflow("external-event"), audit), held.id, "webhook");
    expect(result).toEqual({ released: true, toColumn: "in-progress" });
    if (audit) expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:hold-release-event", taskId: "FN-1", agentId: "scheduler", runId: "hold-release:event:FN-1",
    }));
  });

  it("pre-observes a late fire-and-forget rejection", async () => {
    let reject!: (error: Error) => void;
    const late = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const held = task({});
      await releaseHeldTaskByEvent(storeFor([held], workflow("external-event"), () => late), held.id, "webhook");
      reject(new Error("late sink failure"));
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });
});
