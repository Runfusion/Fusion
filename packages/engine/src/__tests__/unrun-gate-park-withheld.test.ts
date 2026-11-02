import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

/*
FNXC:UnrunGateParkWithheldNotice 2026-11-02-03:45 (RUFU-318, Symptom Verification):
RUFU-276's arm could only describe the repairs it made. An 8-day withheld repair left no task-log line,
one audit row for the whole engine lifetime, and no notice — so "the arm never ran" and "the arm refused
every pass" were the same board state, and RUFU-225's own disk mirror looked like a guard-level puzzle
while the row behind it did not exist. This file drives the production sweep over the recorded RUFU-225
shape with the seed forced to refuse, and pins the paired signal, its per-window re-announce, the durable
History marker, the mailbox notice, and the untouched success path.
*/
const recovery = vi.hoisted(() => ({
  capture: vi.fn(),
  reroute: vi.fn(),
  resolveColumns: vi.fn(),
  resolveGate: vi.fn(),
  blocker: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveProjectColumnsForRoles: recovery.resolveColumns,
  resolvePreMergeGateForTask: recovery.resolveGate,
  getTaskMergeBlocker: recovery.blocker,
}));
vi.mock("../merge/merge-content-capture.js", () => ({ captureMergeContentDescriptor: recovery.capture }));
/*
The seed lane is the thing being refused, so it is the one seam this file controls directly. Everything the
arm reasons over — `classifyUnrunGatePark`, `isRecoverableUnrunGatePark`, the refusal vocabulary — stays real,
because a mocked classifier would let a broken classification pass as a withheld repair.
*/
vi.mock("../merge/pre-merge-gate-reseed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../merge/pre-merge-gate-reseed.js")>()),
  rerouteUnrunPreMergeGateToReview: recovery.reroute,
}));

import { PRE_MERGE_STEPS_NOT_RUN_BLOCKER, WEDGE_RENOTIFY_COOLDOWN_MS, type Task } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { AUTO_MERGE_RETRY_REJECTED_PREFIX } from "../merge/stale-content-park.js";
import {
  UNRUN_GATE_PARK_NO_ACTION_EVENT,
  UNRUN_GATE_PARK_REFUSAL_REASONS,
  unrunGateParkNoticeKey,
} from "../notification/unrun-gate-park-notice.js";
import type { UnrunPreMergeGateRefusalReason } from "../merge/pre-merge-gate-reseed.js";

/** RUFU-225's terminal sentence: the retry rejection wrapping the canonical never-ran blocker. */
const RETRY_REJECTED = `${AUTO_MERGE_RETRY_REJECTED_PREFIX} Cannot merge RUFU-225FIX: ${PRE_MERGE_STEPS_NOT_RUN_BLOCKER}`;

const IR = {
  columns: [{ id: "in-review", flag: "review" }],
  nodes: [{ id: "code-review", kind: "step-review", column: "in-review", config: { reviewKind: "code" } }],
};

/** The park RUFU-225 was in: failed, canonical refusal, and a required gate with zero result rows. */
function parkedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-225FIX",
    title: "Withheld never-ran gate repair",
    description: "",
    column: "in-review",
    status: "failed",
    error: RETRY_REJECTED,
    autoMerge: true,
    worktree: "/tmp/rufu-225fix",
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    dependencies: [],
    mergeRetries: 3,
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [{ workflowStepId: "code-review", status: "passed", reviewInputFingerprint: "fp" }],
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T14:08:16.000Z",
    ...overrides,
  } as Task;
}

function recoveryStore(task: Task, options: { logEntryOnce?: boolean; auditSink?: "ok" | "throws" | "hangs" | "absent" } = {}) {
  const auditSink = options.auditSink ?? "ok";
  const store: Record<string, unknown> = {
    getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async (o?: { column?: string }) => (o?.column === "in-review" ? [task] : [])),
    getTask: vi.fn(async () => task),
    getProjectId: vi.fn(() => "test-project"),
    getStaleReviewCallbackWaiverReceipts: vi.fn(async () => []),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    updateTaskAtomic: vi.fn(async (_id: string, reduce: (live: Task) => Partial<Task> | null) => {
      const patch = reduce(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async () => task),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    // RUFU-584's pass-cache contract; a constant epoch because nothing here writes a workflow mid-pass.
    workflowDefinitionEpoch: vi.fn(() => 0),
    workflowSelectionEpoch: vi.fn(() => 0),
  };
  if (options.logEntryOnce !== false) {
    store.logEntryOnce = vi.fn(async (_id: string, input: { dedupeKey: string; windowMs: number }) => {
      void input;
      return true;
    });
  }
  if (auditSink === "throws") {
    store.recordRunAuditEvent = vi.fn(async () => { throw new Error("audit store unreachable"); });
  } else if (auditSink === "hangs") {
    store.recordRunAuditEvent = vi.fn(() => new Promise(() => undefined));
  } else if (auditSink === "absent") {
    delete store.recordRunAuditEvent;
  }
  return store as any;
}

function refused(reason: UnrunPreMergeGateRefusalReason) {
  recovery.reroute.mockResolvedValue({ rerouted: false, reason, nodeId: undefined, workflowStepId: undefined });
}

function auditRows(store: any, mutationType: string) {
  const sink = store.recordRunAuditEvent;
  if (!sink) return [];
  return sink.mock.calls
    .map((call: unknown[]) => (call[0] ?? {}) as { mutationType?: string; metadata?: Record<string, unknown> })
    .filter((row) => row.mutationType === mutationType);
}

function withheldLines(store: any): string[] {
  const lines: string[] = [];
  for (const call of store.logEntry.mock.calls as unknown as Array<[string, string]>) lines.push(call[1]);
  if (store.logEntryOnce) {
    for (const call of store.logEntryOnce.mock.calls as unknown as Array<[string, { action: string }]>) lines.push(call[1].action);
  }
  return lines.filter((line) => line.includes("[unrun-gate-park-withheld]"));
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-02T09:00:00.000Z") });
  recovery.resolveColumns.mockResolvedValue(new Set(["in-review"]));
  recovery.resolveGate.mockResolvedValue({
    provenance: "selection",
    selectionAbsent: false,
    requiredPreMergeStepIds: new Set(["plan-review", "code-review"]),
    reviewColumns: new Set(["in-review"]),
  });
  // The visible FN-9243 lane reads the merge blocker; declining there is what routes this card to the hidden arm.
  recovery.blocker.mockReturnValue(undefined);
  recovery.capture.mockResolvedValue({ kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } });
  refused("active-continuation");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withheld never-ran gate repair — paired -no-action signal", () => {
  it.each([
    ["retry-rejected", { error: RETRY_REJECTED }],
    ["raw-blocker", { error: PRE_MERGE_STEPS_NOT_RUN_BLOCKER }],
  ] as const)("names the refusing guard for a %s park", async (parkShape, patch) => {
    const task = parkedTask(patch);
    const store = recoveryStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix" });

    await manager.recoverMergeableReviewTasks();

    const rows = auditRows(store, UNRUN_GATE_PARK_NO_ACTION_EVENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual(expect.objectContaining({
      taskId: task.id,
      outcome: "seed-refused",
      refusalReason: "active-continuation",
      parkShape,
      missingGateCount: 1,
      source: "self-healing",
      notice: "unavailable",
    }));
    // AC2: ids, counts and fixed enums only — the row's key set is closed, so no prose can enter it.
    expect(Object.keys(rows[0]!.metadata!).sort()).toEqual([
      "missingGateCount",
      "notice",
      "outcome",
      "parkShape",
      "refusalReason",
      "source",
      "taskId",
      "withheldAgeMs",
      "workflowStepId",
    ]);
    // The withheld outcome must no longer be recorded as a repair, and it must not clear the park.
    expect(auditRows(store, "task:merge-unrun-gate-park-repaired")).toHaveLength(0);
    expect(task.status).toBe("failed");
    expect(task.error).toBe(patch.error);
    // A durable History line exists on the card, so the refusal is readable without the audit store.
    expect(withheldLines(store)).toHaveLength(1);
    manager.stop();
  });

  it("keeps the refusal vocabulary closed so a success value cannot enter a refusal row", () => {
    expect(new Set(UNRUN_GATE_PARK_REFUSAL_REASONS)).toEqual(new Set([
      "rerun-budget-exhausted",
      "active-continuation",
      "no-unrun-gate",
      "no-review-route",
      "not-singular",
      "operator-held",
      "workflow-selection-changed",
      "park-signature-drift",
    ]));
  });

  it("re-announces a persistent refusal per window and stays deduped inside one", async () => {
    const task = parkedTask();
    const store = recoveryStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix" });

    await manager.recoverMergeableReviewTasks();
    await manager.recoverMergeableReviewTasks();
    // One audit row per window; the History seam is store-deduped, and this fake reports every append.
    expect(auditRows(store, UNRUN_GATE_PARK_NO_ACTION_EVENT)).toHaveLength(1);
    expect(withheldLines(store)).toHaveLength(2);

    vi.advanceTimersByTime(WEDGE_RENOTIFY_COOLDOWN_MS + 60_000);
    await manager.recoverMergeableReviewTasks();

    const rows = auditRows(store, UNRUN_GATE_PARK_NO_ACTION_EVENT);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.metadata?.withheldAgeMs))).toHaveLength(2);
    manager.stop();
  });

  it("records the fenced-clear drift as its own refusing guard and leaves the park intact", async () => {
    const task = parkedTask();
    const store = recoveryStore(task);
    // The seed reports success, then the live row drifts under the fenced clear.
    recovery.reroute.mockResolvedValue({ rerouted: true, reason: "seeded", nodeId: "plan-review", workflowStepId: "plan-review" });
    store.updateTaskAtomic = vi.fn(async (_id: string, reduce: (live: Task) => unknown) => {
      reduce({ ...task, status: null, paused: true } as Task);
      return task;
    });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix" });

    await manager.recoverMergeableReviewTasks();

    const rows = auditRows(store, UNRUN_GATE_PARK_NO_ACTION_EVENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual(expect.objectContaining({
      outcome: "signature-drift",
      refusalReason: "park-signature-drift",
      workflowStepId: "plan-review",
    }));
    expect(task.status).toBe("failed");
    expect(auditRows(store, "task:merge-unrun-gate-park-repaired")).toHaveLength(0);
    manager.stop();
  });

  it("leaves the success path byte-identical: one repaired row and both pre-merge lines", async () => {
    const task = parkedTask();
    const store = recoveryStore(task);
    recovery.reroute.mockResolvedValue({ rerouted: true, reason: "seeded", nodeId: "plan-review", workflowStepId: "plan-review" });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix" });

    await manager.recoverMergeableReviewTasks();

    const repaired = auditRows(store, "task:merge-unrun-gate-park-repaired");
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.metadata).toEqual(expect.objectContaining({
      taskId: task.id,
      workflowStepId: "plan-review",
      missingGateCount: 1,
      source: "self-healing",
      outcome: "repaired",
    }));
    expect(auditRows(store, UNRUN_GATE_PARK_NO_ACTION_EVENT)).toHaveLength(0);
    expect(withheldLines(store)).toHaveLength(0);
    const seedLines = (store.logEntry.mock.calls as unknown as Array<[string, string]>)
      .map((call) => call[1])
      .filter((line) => line.startsWith("[pre-merge]"));
    expect(seedLines).toEqual([
      `[pre-merge] Self-healing re-seeded the workflow graph at the never-ran pre-merge gate 'plan-review' that had parked this card.`,
      `[pre-merge] Cleared the retry-rejected merge park after re-seeding a fresh run of the never-ran gate 'plan-review'.`,
    ]);
    expect(store.logEntryOnce).not.toHaveBeenCalled();
    expect(task).toMatchObject({ status: null, error: null, mergeRetries: 0 });
    manager.stop();
  });
});

describe("withheld never-ran gate repair — mailbox notice", () => {
  function messageStore() {
    return { sendMessageOnce: vi.fn(async () => ({ message: { id: "m-1" }, inserted: true })) };
  }

  it("re-offers one notice key per window, a fresh key after it, and records the outcome", async () => {
    const task = parkedTask();
    const store = recoveryStore(task);
    const messages = messageStore();
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix", messageStore: messages });

    await manager.recoverMergeableReviewTasks();
    await manager.recoverMergeableReviewTasks();

    /*
    The arm re-offers the notice on every pass and `sendMessageOnce`'s conflict-ignored insert is the
    authority that collapses it to ONE mailbox message: the same idempotency key inside the window, a new
    key after it. That is RUFU-371's documented contract, and an in-process gate here would only make the
    collapse untestable while a restart re-offered anyway.
    */
    const calls = messages.sendMessageOnce.mock.calls as unknown as Array<[Record<string, any>, string]>;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toBe(calls[0]![1]);
    const [input, idempotencyKey] = calls[0]!;
    // The seed refused before naming a gate, so the arm names the gate from the park's own missing list.
    expect(idempotencyKey).toBe(unrunGateParkNoticeKey(task.id, "seed-refused", "active-continuation", "plan-review", Date.now()));
    expect(input.metadata).toEqual({
      kind: "unrun-gate-park-withheld",
      taskId: task.id,
      outcome: "seed-refused",
      refusalReason: "active-continuation",
      workflowStepId: "plan-review",
    });
    expect(input.content).toContain(task.id);
    expect(input.content).toContain("active-continuation");
    // The notice body carries the park's durable age, never the blocker sentence.
    expect(input.content).toContain("park waiting");
    expect(auditRows(store, UNRUN_GATE_PARK_NO_ACTION_EVENT)[0]!.metadata).toEqual(expect.objectContaining({ notice: "delivered" }));

    // A later window is a new episode for the operator: a fresh key, so the notice re-announces.
    vi.advanceTimersByTime(WEDGE_RENOTIFY_COOLDOWN_MS + 60_000);
    await manager.recoverMergeableReviewTasks();
    const laterKey = (messages.sendMessageOnce.mock.calls[2] as unknown as [Record<string, any>, string])[1];
    expect(laterKey).not.toBe(idempotencyKey);
    manager.stop();
  });

  it("records notice:unavailable without changing the withheld outcome when no mailbox exists", async () => {
    const task = parkedTask();
    const store = recoveryStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix" });

    await manager.recoverMergeableReviewTasks();

    expect(auditRows(store, UNRUN_GATE_PARK_NO_ACTION_EVENT)[0]!.metadata).toEqual(expect.objectContaining({ notice: "unavailable" }));
    expect(task.status).toBe("failed");
    expect(withheldLines(store)).toHaveLength(1);
    manager.stop();
  });

  it("lets a throwing or hanging audit sink change nothing", async () => {
    // Real timers: the bounded seam's own 2 s timer must actually fire against a never-settling sink.
    vi.useRealTimers();
    for (const auditSink of ["throws", "hangs", "absent"] as const) {
      const task = parkedTask({ id: `RUFU-SINK-${auditSink}` });
      const store = recoveryStore(task, { auditSink });
      const messages = messageStore();
      const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix", messageStore: messages });

      await expect(manager.recoverMergeableReviewTasks()).resolves.toBe(0);

      expect(task.status).toBe("failed");
      expect(withheldLines(store)).toHaveLength(1);
      expect(messages.sendMessageOnce).toHaveBeenCalledOnce();
      manager.stop();
    }
  }, 20_000);
});

describe("withheld never-ran gate repair — containment", () => {
  it("moves no card, touches no verdict row, and keeps the one-marker budget per signature", async () => {
    const task = parkedTask();
    const store = recoveryStore(task, { logEntryOnce: false });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/rufu-225fix" });
    const resultsBefore = JSON.stringify(task.workflowStepResults);

    for (let pass = 0; pass < 3; pass += 1) await manager.recoverMergeableReviewTasks();

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(task.workflowStepResults).toEqual(JSON.parse(resultsBefore));
    expect(task.column).toBe("in-review");
    // Without the store-side dedupe seam the fallback still writes one line per signature, not one per pass.
    expect(withheldLines(store)).toHaveLength(1);
    manager.stop();
  });
});
