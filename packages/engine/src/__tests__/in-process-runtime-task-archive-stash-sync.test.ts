/*
FNXC:RUFU125BulkArchiveSync 2026-08-19-06:07:
RUFU-125 regression surface (engine side): the in-process runtime's task-moved archive
listener must (a) snapshot the doomed task-planner chat sessions WITH project scoping
(fail-open), (b) run the local bulk delete with project scoping exactly as pre-RUFU-125,
and (c) fire a best-effort bulk Stash sync for the doomed ids — never blocking or
rejecting the task:moved chain — while the forwarded runtime task:moved event still
fires exactly once.

Drives setupEventForwarding() on a MINIMAL instance via Object.create(
InProcessRuntime.prototype) — the runtime-shaped regression without booting the runtime
(InProcessRuntime extends EventEmitter, so emit comes from the prototype).
bulkDeleteStashChatSessions is mocked via the @fusion/core vi.mock spread; the REAL
resolveTaskLifecycleColumns runs against the mock store and settles on the default
archived lane — the intended path under test.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

const { mockBulkDeleteStashChatSessions } = vi.hoisted(() => ({
  mockBulkDeleteStashChatSessions: vi.fn(),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    // RUFU-125: the archive-listener sync target — mocked so tests observe the call
    // contract without touching Stash HTTP. Everything else (including the real
    // resolveTaskLifecycleColumns) stays real.
    bulkDeleteStashChatSessions: mockBulkDeleteStashChatSessions,
  };
});

type MinimalRuntime = EventEmitter & Record<string, unknown>;

interface ChatStoreDoubles {
  listSessions: ReturnType<typeof vi.fn>;
  deleteSessionsForAgentId: ReturnType<typeof vi.fn>;
}

function makeChatStoreDoubles(
  overrides: Partial<Record<keyof ChatStoreDoubles, unknown>> = {},
): { chatStore: ChatStoreDoubles & EventEmitter; methods: ChatStoreDoubles } {
  const methods: ChatStoreDoubles = {
    listSessions: vi.fn().mockResolvedValue([]),
    deleteSessionsForAgentId: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as ChatStoreDoubles;
  const chatStore = Object.assign(new EventEmitter(), methods);
  return { chatStore, methods };
}

function makeMinimalRuntime(chatStore: unknown): { taskStore: EventEmitter & { getSettings: ReturnType<typeof vi.fn> }; runtime: MinimalRuntime } {
  const taskStore = Object.assign(new EventEmitter(), {
    getSettings: vi.fn().mockResolvedValue({}),
  });
  const runtime = Object.create(InProcessRuntime.prototype) as MinimalRuntime;
  runtime.taskStore = taskStore;
  runtime.chatStore = chatStore;
  runtime.config = { projectId: "proj-1" };
  runtime.recordActivity = vi.fn();
  runtime.approvalHeldTaskIds = new Set<string>();
  runtime.approvalReleasedTaskIds = new Set<string>();
  runtime.kickWorkflowContinuationProcessor = vi.fn();
  (runtime as unknown as { setupEventForwarding(): void }).setupEventForwarding();
  return { taskStore, runtime };
}

function emitTaskMoved(taskStore: EventEmitter, to: string, taskId = "FN-77"): void {
  taskStore.emit("task:moved", { task: { id: taskId }, from: "done", to });
}

/** Flush all pending microtasks (and one macrotask) so listener chains settle. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

function trackUnhandledRejections(): { unhandled: unknown[]; stop: () => void } {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", listener);
  return { unhandled, stop: () => process.off("unhandledRejection", listener) };
}

const FULL_RESULT = {
  targets: 2,
  matched: 2,
  deleted: 2,
  pagesScanned: 1,
  truncated: false,
};

describe("InProcessRuntime task-moved archive → bulk Stash chat-session sync (RUFU-125)", () => {
  beforeEach(() => {
    mockBulkDeleteStashChatSessions.mockReset();
    mockBulkDeleteStashChatSessions.mockResolvedValue({ skipped: false, result: FULL_RESULT });
  });

  it("archiving a task snapshots doomed sessions project-scoped, deletes locally, fires the bulk sync, and still forwards the event", async () => {
    const { chatStore, methods } = makeChatStoreDoubles({
      listSessions: vi.fn().mockResolvedValue([{ id: "chat-xxx" }, { id: "chat-yyy" }]),
      deleteSessionsForAgentId: vi.fn().mockResolvedValue(2),
    });
    const { taskStore, runtime } = makeMinimalRuntime(chatStore);
    const forwarded: unknown[] = [];
    runtime.on("task:moved", (data: unknown) => forwarded.push(data));

    emitTaskMoved(taskStore, "archived");

    await vi.waitFor(() => {
      expect(methods.listSessions).toHaveBeenCalledWith({ agentId: "task-planner:FN-77", projectId: "proj-1" });
      expect(methods.deleteSessionsForAgentId).toHaveBeenCalledWith("task-planner:FN-77", { projectId: "proj-1" });
      expect(mockBulkDeleteStashChatSessions).toHaveBeenCalledTimes(1);
      expect(mockBulkDeleteStashChatSessions).toHaveBeenCalledWith(taskStore, ["chat-xxx", "chat-yyy"]);
    });

    // The forwarded runtime event fires exactly once, with the original payload.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ task: { id: "FN-77" }, from: "done", to: "archived" });
  });

  it("a non-archive move makes no chat calls and no sync (event still forwarded)", async () => {
    const { chatStore, methods } = makeChatStoreDoubles();
    const { taskStore, runtime } = makeMinimalRuntime(chatStore);
    const forwarded: unknown[] = [];
    runtime.on("task:moved", (data: unknown) => forwarded.push(data));

    emitTaskMoved(taskStore, "done");
    await settle();

    expect(methods.listSessions).not.toHaveBeenCalled();
    expect(methods.deleteSessionsForAgentId).not.toHaveBeenCalled();
    expect(mockBulkDeleteStashChatSessions).not.toHaveBeenCalled();
    expect(forwarded).toHaveLength(1);
  });

  it("chatStore undefined: no crash, no chat calls, forwarded event still fires", async () => {
    const { taskStore, runtime } = makeMinimalRuntime(undefined);
    const forwarded: unknown[] = [];
    runtime.on("task:moved", (data: unknown) => forwarded.push(data));

    expect(() => emitTaskMoved(taskStore, "archived")).not.toThrow();
    await settle();

    expect(mockBulkDeleteStashChatSessions).not.toHaveBeenCalled();
    expect(forwarded).toHaveLength(1);
  });

  it("bulk sync rejecting never becomes an unhandled rejection (the catch logs)", async () => {
    const { unhandled, stop } = trackUnhandledRejections();
    try {
      mockBulkDeleteStashChatSessions.mockRejectedValue(new Error("stash down"));
      const { chatStore, methods } = makeChatStoreDoubles({
        listSessions: vi.fn().mockResolvedValue([{ id: "chat-xxx" }]),
        deleteSessionsForAgentId: vi.fn().mockResolvedValue(1),
      });
      const { taskStore, runtime } = makeMinimalRuntime(chatStore);
      const forwarded: unknown[] = [];
      runtime.on("task:moved", (data: unknown) => forwarded.push(data));

      emitTaskMoved(taskStore, "archived");

      await vi.waitFor(() => {
        expect(methods.deleteSessionsForAgentId).toHaveBeenCalledWith("task-planner:FN-77", { projectId: "proj-1" });
        expect(mockBulkDeleteStashChatSessions).toHaveBeenCalledTimes(1);
      });
      await settle();
      expect(forwarded).toHaveLength(1);
      expect(unhandled).toHaveLength(0);
    } finally {
      stop();
    }
  });
});
