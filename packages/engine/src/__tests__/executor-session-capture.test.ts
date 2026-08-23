/**
 * FNXC:StashSessionCapture 2026-08-19-04:37:
 * RUFU-122 Step 3 tests: the pure task-transcript builder
 * (buildTaskTranscriptEvents — agent-log.jsonl entries -> ordered Stash
 * memory events) and the restructured triggerTaskMemoryCapture (transcript +
 * terminal anchor in one captureMemory call, gated by the operator-fixed
 * executorSessionCapture* settings). The deterministic seam mirrors the
 * RUFU-068 capture tests: a partial @fusion/core mock with captureMemory as a
 * spy, so no network write is ever attempted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLogEntry } from "@fusion/core";
import {
  buildTaskTranscriptEvents,
  triggerTaskMemoryCapture,
  TRANSCRIPT_CONTENT_MAX_CHARS,
} from "../executor/memory-capture.js";
import { TaskExecutorGraphFacades } from "../executor/task-executor-graph-facades.js";

/**
 * Partial mock: keep every real @fusion/core symbol except `captureMemory`, which becomes a
 * deterministic spy so capture paths never attempt a real (or dangling-url) network write.
 */
const { mockCaptureMemory, mockHandleGraphFailureImpl } = vi.hoisted(() => ({
  mockCaptureMemory: vi.fn(),
  mockHandleGraphFailureImpl: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return { ...mod, captureMemory: mockCaptureMemory };
});

/*
FNXC:StashSessionCapture 2026-08-19-06:55:
(RUFU-122 Step 4) The handleGraphFailure facade is the choke point for every
GRAPH-LEVEL terminal failure (drift parks, settings-load failures,
non-execute-node failures) that terminalizes the task `status: "failed"` OUTSIDE
runImplementation's post-loop finally. The facade must re-read the task and fire
the shared triggerTaskMemoryCapture exactly once when the fresh row is terminally
failed — and a completion-seam fire on the SAME capturedMemoryTaskIds Set after
that must be a no-op (at most once per task across seams). The impl's parking
behavior itself is covered by the handle-graph-failure tests, so only
handleGraphFailureImpl is stubbed here; captureMemory stays the @fusion/core spy.
*/
vi.mock("../executor/impl-bindings.js", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return { ...mod, handleGraphFailureImpl: mockHandleGraphFailureImpl };
});

const TASK = { id: "FN-99", title: "Ship feature", status: "done" } as any;
const PROJECT = { project: "proj-123", project_name: "proj-alpha" };

function entry(type: AgentLogEntry["type"], text: string, i: number): AgentLogEntry {
  return {
    timestamp: `2026-08-19T04:00:${String(i).padStart(2, "0")}.000Z`,
    taskId: "FN-99",
    text,
    type,
  };
}

describe("buildTaskTranscriptEvents (pure builder, RUFU-122)", () => {
  it("maps tool / tool_result / tool_error one-to-one with the settled content rules", () => {
    const events = buildTaskTranscriptEvents(
      [
        entry("tool", "fn_task_list", 1),
        entry("tool_result", "3 tasks found", 2),
        entry("tool_error", "boom", 3),
      ],
      "FN-99",
      "done",
      PROJECT,
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ event_type: "tool_use", content: "fn_task_list", tool_name: "fn_task_list" });
    expect(events[0].created_at).toBe("2026-08-19T04:00:01.000Z");
    expect(events[1]).toMatchObject({ event_type: "tool_result", content: "3 tasks found" });
    // The error marker is part of the stored content (operator requirement).
    expect(events[2]).toMatchObject({ event_type: "tool_error", content: "ERROR: boom" });
    expect(events[2].created_at).toBe("2026-08-19T04:00:03.000Z");
  });

  it("glues consecutive text deltas into ONE assistant_message (first-entry timestamp/line)", () => {
    const events = buildTaskTranscriptEvents(
      [
        entry("text", "Hello ", 1),
        entry("text", "world", 2),
        entry("text", "!", 3),
        entry("tool", "fn_task_done", 4),
      ],
      "FN-99",
      "done",
      PROJECT,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event_type: "assistant_message", content: "Hello world!" });
    // created_at and line come from the RUN'S FIRST entry, not the last.
    expect(events[0].created_at).toBe("2026-08-19T04:00:01.000Z");
    expect(events[0].metadata).toEqual({
      taskId: "FN-99",
      status: "done",
      line: 1,
      project: "proj-123",
      project_name: "proj-alpha",
    });
    expect(events[1]).toMatchObject({ event_type: "tool_use", content: "fn_task_done" });
    expect(events[1].metadata?.line).toBe(4);
  });

  it("keeps non-adjacent text runs as separate events", () => {
    const events = buildTaskTranscriptEvents(
      [
        entry("text", "A", 1),
        entry("tool", "read", 2),
        entry("text", "B", 3),
        entry("text", "C", 4),
      ],
      "FN-99",
      "failed",
      PROJECT,
    );
    expect(events.map((e) => e.event_type)).toEqual(["assistant_message", "tool_use", "assistant_message"]);
    expect(events[2]).toMatchObject({ content: "BC" });
    expect(events[2].created_at).toBe("2026-08-19T04:00:03.000Z");
    // The status parameter flows into every event's metadata.
    expect(events[0].metadata?.status).toBe("failed");
  });

  it("skips thinking entries and (by default) status entries", () => {
    const events = buildTaskTranscriptEvents(
      [
        entry("thinking", "pondering", 1),
        entry("status", "Step 1 complete", 2),
        entry("text", "done", 3),
      ],
      "FN-99",
      "done",
      PROJECT,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "assistant_message", content: "done" });
    expect(events[0].metadata?.line).toBe(3);
  });

  it("truncates event content to 4000 chars client-side", () => {
    const long = "x".repeat(TRANSCRIPT_CONTENT_MAX_CHARS + 500);
    const events = buildTaskTranscriptEvents(
      [entry("text", long, 1), entry("tool_error", "y".repeat(TRANSCRIPT_CONTENT_MAX_CHARS + 100), 2)],
      "FN-99",
      "done",
      PROJECT,
    );
    expect(events[0].content).toHaveLength(TRANSCRIPT_CONTENT_MAX_CHARS);
    // tool_error truncation applies AFTER the "ERROR: " prefix is prepended.
    expect(events[1].content).toHaveLength(TRANSCRIPT_CONTENT_MAX_CHARS);
    expect(events[1].content.startsWith("ERROR: ")).toBe(true);
  });
});

describe("triggerTaskMemoryCapture (RUFU-122 transcript + anchor)", () => {
  beforeEach(() => {
    mockCaptureMemory.mockReset();
    mockCaptureMemory.mockResolvedValue({ ok: true, inserted: 1, deduped: 0 });
  });

  function runTrigger(
    settings: Record<string, unknown>,
    entries: AgentLogEntry[],
    task: any = TASK,
    storeExtras: Record<string, unknown> = {},
    anchorKind: "completion" | "failure" = "completion",
  ) {
    return triggerTaskMemoryCapture(
      {
        store: {
          getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash", ...settings }),
          getSecretsStore: async () => ({
            revealSecret: async () => ({ key: "stash-api-key", plaintextValue: "k" }),
          }),
          getAgentLogs: async () => entries,
          ...storeExtras,
        } as any,
        capturedMemoryTaskIds: new Set<string>(),
        rootDir: "/home/schindler/git/proj-alpha",
      },
      task,
      anchorKind,
    );
  }

  // Alternating text/tool so no two text entries are adjacent — each text is its
  // own run, so 10 entries produce exactly 10 transcript events (lines 1..10).
  const TEN = Array.from({ length: 10 }, (_, i) =>
    i % 2 === 0 ? entry("text", `say ${i + 1}`, i + 1) : entry("tool", `tool ${i + 1}`, i + 1),
  );

  it("uploads the transcript in front of a task_completion anchor in one call", async () => {
    await runTrigger({}, TEN, TASK, { getWorkflowSettingsProjectId: () => "proj-123" });
    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const [, , sessionId, events, meta] = mockCaptureMemory.mock.calls[0];
    expect(sessionId).toBe("fusion-task-FN-99");
    expect(meta).toMatchObject({ taskId: "FN-99" });
    expect(events).toHaveLength(11); // 10 transcript + 1 anchor
    expect(events.slice(0, 10).every((e) => ["assistant_message", "tool_use"].includes(e.event_type))).toBe(true);
    // The anchor is LAST.
    expect(events[10]).toMatchObject({
      event_type: "task_completion",
      content: "Ship feature",
      metadata: {
        taskId: "FN-99",
        status: "done",
        project: "proj-123",
        project_name: "proj-alpha", // basename(rootDir) fallback
      },
    });
    // Per-event metadata shape + project identity (no runtime identity supplied).
    expect(events[0].metadata).toEqual({
      taskId: "FN-99",
      status: "done",
      line: 1,
      project: "proj-123",
      project_name: "proj-alpha",
    });
  });

  it("emits a task_failure anchor for a failed task", async () => {
    // The anchor kind is the SEAM's identity (terminal-failure seam), not a
    // task.status read — the engine never writes status "done" onto the row.
    await runTrigger({}, [entry("text", "x", 1)], { ...TASK, status: "failed" }, {}, "failure");
    const events = mockCaptureMemory.mock.calls[0][3];
    expect(events[events.length - 1]).toMatchObject({
      event_type: "task_failure",
      content: "Ship feature",
      metadata: { status: "failed" },
    });
  });

  it("no log: getAgentLogs -> [] captures exactly the anchor, warns, never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runTrigger({}, [])).resolves.toBeUndefined();
    const events = mockCaptureMemory.mock.calls[0][3];
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("task_completion");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("executorSessionCaptureEnabled: false -> anchor only, no transcript (and no log read)", async () => {
    const getAgentLogs = vi.fn(async () => TEN);
    await runTrigger({ executorSessionCaptureEnabled: false }, TEN, TASK, { getAgentLogs });
    const events = mockCaptureMemory.mock.calls[0][3];
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("task_completion");
    expect(getAgentLogs).not.toHaveBeenCalled();
  });

  it("executorSessionCaptureIncludeStatus: true -> status events present in log order", async () => {
    const entries = [
      entry("text", "work", 1),
      entry("status", "Step 1 done", 2),
      entry("tool", "read", 3),
      entry("status", "Step 2 done", 4),
    ];
    await runTrigger({ executorSessionCaptureIncludeStatus: true }, entries);
    const events = mockCaptureMemory.mock.calls[0][3];
    expect(events.map((e) => e.event_type)).toEqual([
      "assistant_message",
      "status",
      "tool_use",
      "status",
      "task_completion",
    ]);
    const statusEvents = events.filter((e) => e.event_type === "status");
    expect(statusEvents.map((e) => e.content)).toEqual(["Step 1 done", "Step 2 done"]);
    expect(statusEvents[0].metadata?.line).toBe(2);
    expect(statusEvents[1].metadata?.line).toBe(4);
  });

  it("max-events cap keeps the MOST RECENT N transcript events (tail) + anchor", async () => {
    await runTrigger({ executorSessionCaptureMaxEvents: 5 }, TEN);
    const events = mockCaptureMemory.mock.calls[0][3];
    expect(events).toHaveLength(6); // 5 transcript (tail) + 1 anchor
    // The tail is entries 6..10 (1-based lines 6..10).
    expect(events.slice(0, 5).map((e) => e.metadata?.line)).toEqual([6, 7, 8, 9, 10]);
    expect(events[5].event_type).toBe("task_completion");
  });

  it("shared gate: capture fires at most once across the complete + terminal-failure seams", async () => {
    // The completion seam (signalTaskComplete) and the terminal-failure seam
    // (run-implementation finally → signalTaskTerminalFailed) share ONE
    // capturedMemoryTaskIds Set — the spec's at-most-once guarantee across
    // seams lives here, in the trigger, not in either caller.
    const capturedMemoryTaskIds = new Set<string>();
    const store = {
      getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash" }),
      getSecretsStore: async () => ({ revealSecret: async () => ({ key: "stash-api-key", plaintextValue: "k" }) }),
      getAgentLogs: async () => [entry("text", "working...", 1)],
    } as any;
    const deps = { store, capturedMemoryTaskIds, rootDir: "/home/schindler/git/proj-alpha" };

    // Completion seam fires first (anchor kind "completion")...
    await triggerTaskMemoryCapture(deps, TASK, "completion");
    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);

    // ...then the terminal-failure seam fires on the same task — the shared
    // gate must suppress the second capture.
    await triggerTaskMemoryCapture(deps, { ...TASK, status: "failed" }, "failure");
    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const first = mockCaptureMemory.mock.calls[0][3];
    expect(first[first.length - 1].event_type).toBe("task_completion");

    // Reverse order: a failure captured first is not re-captured on completion.
    mockCaptureMemory.mockClear();
    const reverseDeps = { store, capturedMemoryTaskIds: new Set<string>(), rootDir: "/home/schindler/git/proj-alpha" };
    await triggerTaskMemoryCapture(reverseDeps, { ...TASK, status: "failed" }, "failure");
    await triggerTaskMemoryCapture(reverseDeps, TASK, "completion");
    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const second = mockCaptureMemory.mock.calls[0][3];
    expect(second[second.length - 1].event_type).toBe("task_failure");
  });

  it("does nothing when memory is disabled", async () => {
    await triggerTaskMemoryCapture(
      {
        store: { getSettings: async () => ({ memoryEnabled: false }) } as any,
        capturedMemoryTaskIds: new Set<string>(),
        rootDir: "/proj",
      },
      TASK,
    );
    expect(mockCaptureMemory).not.toHaveBeenCalled();
  });

  it("does nothing for a non-stash backend (no capture, no secret read)", async () => {
    const getSecretsStore = vi.fn(async () => ({
      revealSecret: async () => ({ key: "stash-api-key", plaintextValue: "k" }),
    }));
    await runTrigger({}, TEN, TASK, {
      getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "qmd" }),
      getSecretsStore,
    });
    expect(mockCaptureMemory).not.toHaveBeenCalled();
    expect(getSecretsStore).not.toHaveBeenCalled();
  });
});

/*
FNXC:StashSessionCapture 2026-08-19-06:55:
(RUFU-122 Step 4) Facade-level coverage for the GRAPH terminal-failure capture
seam (spec Step 4): the handleGraphFailure facade re-reads the task after
handleGraphFailureImpl resolves and, when the fresh row is terminally failed,
fires the same shared trigger the completion and in-run-failure seams use.
handleGraphFailureImpl is stubbed (its parking behavior is tested elsewhere);
the real triggerTaskMemoryCapture runs against the captureMemory spy so the
assertions are on the actual captured events, not on the seam call itself.
*/
describe("handleGraphFailure facade terminal-failure seam (RUFU-122)", () => {
  // Concrete host for the abstract facade chain; only the one abstract method
  // (getActiveWorktreePaths) needs a body — the capture paths never touch it.
  class TestGraphFacades extends TaskExecutorGraphFacades {
    protected getActiveWorktreePaths(_taskId: string): string[] { return []; }
    handleGraphFailureForTest(task: any, result: any) { return this.handleGraphFailure(task, result); }
  }

  function makeFacade(store: any): { facade: TestGraphFacades; capturedMemoryTaskIds: Set<string> } {
    const facade = new TestGraphFacades() as any;
    facade.store = store;
    facade.rootDir = "/home/schindler/git/proj-alpha";
    return { facade, capturedMemoryTaskIds: facade.capturedMemoryTaskIds };
  }

  const captureStoreExtras = {
    getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash" }),
    getSecretsStore: async () => ({
      revealSecret: async () => ({ key: "stash-api-key", plaintextValue: "k" }),
    }),
    getAgentLogs: async () => [entry("text", "working...", 1)],
  };

  beforeEach(() => {
    mockHandleGraphFailureImpl.mockReset();
    mockHandleGraphFailureImpl.mockResolvedValue(undefined);
    mockCaptureMemory.mockReset();
    mockCaptureMemory.mockResolvedValue({ ok: true, inserted: 1, deduped: 0 });
  });

  it("fires the shared capture exactly once for a fresh failed task; a later completion seam is suppressed", async () => {
    const FAILED = { ...TASK, status: "failed" };
    const store = { getTask: async () => FAILED, ...captureStoreExtras } as any;
    const { facade, capturedMemoryTaskIds } = makeFacade(store);

    const result = await facade.handleGraphFailureForTest(FAILED, undefined);
    expect(result).toBeUndefined();
    expect(mockHandleGraphFailureImpl).toHaveBeenCalledTimes(1);
    // The facade fires the trigger fire-and-forget (never blocks the graph-failure
    // outcome), so the captureMemory write lands a few microtasks later — wait for it.
    await vi.waitFor(() => expect(mockCaptureMemory).toHaveBeenCalledTimes(1));
    expect(mockCaptureMemory.mock.calls[0][2]).toBe("fusion-task-FN-99");
    const events = mockCaptureMemory.mock.calls[0][3];
    expect(events[events.length - 1]).toMatchObject({
      event_type: "task_failure",
      content: "Ship feature",
      metadata: { status: "failed" },
    });

    // The completion seam fires for the same task id on the SAME gate set the
    // facade's deps bag read from the host — the shared gate suppresses it.
    await triggerTaskMemoryCapture(
      { store, capturedMemoryTaskIds, rootDir: "/home/schindler/git/proj-alpha" },
      TASK,
      "completion",
    );
    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
  });

  it("does not fire capture when the fresh task is not terminally failed", async () => {
    const PAUSED = { ...TASK, status: "paused" };
    const store = { getTask: async () => PAUSED, ...captureStoreExtras } as any;
    const { facade } = makeFacade(store);

    await facade.handleGraphFailureForTest(PAUSED, undefined);
    expect(mockHandleGraphFailureImpl).toHaveBeenCalledTimes(1);
    expect(mockCaptureMemory).not.toHaveBeenCalled();
  });

  it("never alters the graph-failure outcome when the capture read throws", async () => {
    const FAILED = { ...TASK, status: "failed" };
    const store = {
      getTask: async () => { throw new Error("store down"); },
      ...captureStoreExtras,
    } as any;
    const { facade } = makeFacade(store);
    mockHandleGraphFailureImpl.mockResolvedValue("impl-sentinel");

    const result = await facade.handleGraphFailureForTest(FAILED, undefined);
    expect(result).toBe("impl-sentinel");
    expect(mockCaptureMemory).not.toHaveBeenCalled();
  });
});
