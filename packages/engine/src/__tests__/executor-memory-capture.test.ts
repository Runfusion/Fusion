import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import {
  ChatSessionMemoryCapture,
  chatMessageToMemoryCaptureEvent,
  createStashChatMemoryCaptureSink,
  resolveStashMemorySettings,
  triggerTaskMemoryCapture,
  CHAT_MESSAGE_ADDED,
  CHAT_SESSION_UPDATED,
  type ChatEventEmitter,
} from "../executor/memory-capture.js";

/**
 * Partial mock: keep every real @fusion/core symbol except `captureMemory`, which becomes a
 * deterministic spy so capture paths never attempt a real (or dangling-url) network write.
 */
const { mockCaptureMemory } = vi.hoisted(() => ({ mockCaptureMemory: vi.fn() }));
vi.mock("@fusion/core", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return { ...mod, captureMemory: mockCaptureMemory };
});

/**
 * FNXC:MemoryCapture 2026-08-13-18:05:
 * RUFU-068 complete-chat-session capture engine tests. The deterministic seam is the
 * `ChatSessionMemoryCapture` service (injectable fake emitter + sink — no network), the pure
 * message→event mapping, and the stash-secret resolver, plus the executor's per-task
 * `task_completion` capture routed through `signalTaskComplete`.
 */
describe("resolveStashMemorySettings (stash secret resolution)", () => {
  it("reads the global stash-api-key when backend is stash and no override is set", async () => {
    const store = {
      getSecretsStore: async () => ({
        revealSecret: async () => ({ key: "stash-api-key", plaintextValue: "global-secret" }),
      }),
    };
    const resolved = await resolveStashMemorySettings(store as any, {
      memoryEnabled: true,
      memoryBackendType: "stash",
      stashUrl: "http://127.0.0.1:3457",
    });
    expect(resolved?.stashApiKey).toBe("global-secret");
  });

  it("never reads secrets for a non-stash backend", async () => {
    const revealSecret = vi.fn();
    const store = { getSecretsStore: async () => ({ revealSecret }) };
    const resolved = await resolveStashMemorySettings(store as any, {
      memoryEnabled: true,
      memoryBackendType: "qmd",
    });
    expect(resolved?.stashApiKey).toBeUndefined();
    expect(revealSecret).not.toHaveBeenCalled();
  });

  it("respects a per-project stashApiKey override without touching the secrets store", async () => {
    const revealSecret = vi.fn();
    const store = { getSecretsStore: async () => ({ revealSecret }) };
    const resolved = await resolveStashMemorySettings(store as any, {
      memoryEnabled: true,
      memoryBackendType: "stash",
      stashApiKey: "override",
    });
    expect(resolved?.stashApiKey).toBe("override");
    expect(revealSecret).not.toHaveBeenCalled();
  });

  it("degrades to an empty key instead of throwing when the secrets store is missing", async () => {
    const resolved = await resolveStashMemorySettings({} as any, {
      memoryEnabled: true,
      memoryBackendType: "stash",
    });
    expect(resolved?.stashApiKey).toBeUndefined();
  });
});

describe("chatMessageToMemoryCaptureEvent (message → event mapping)", () => {
  it("maps a user message to a user_message event with agent_name 'fusion'", () => {
    const evt = chatMessageToMemoryCaptureEvent({
      role: "user",
      content: "hello",
      metadata: null,
    });
    expect(evt.event_type).toBe("user_message");
    expect(evt.agent_name).toBe("fusion");
    expect(evt.content).toBe("hello");
  });

  it("maps an assistant message to an assistant_message event", () => {
    const evt = chatMessageToMemoryCaptureEvent({
      role: "assistant",
      content: "hi there",
      metadata: { agent_name: "claude" },
    });
    expect(evt.event_type).toBe("assistant_message");
    expect(evt.agent_name).toBe("claude");
  });

  it("maps a system message with tool metadata to a tool_use event carrying tool_name", () => {
    const evt = chatMessageToMemoryCaptureEvent({
      role: "system",
      content: "ran a tool",
      metadata: { tool_name: "fn_task_list", agentName: "agent-7" },
    });
    expect(evt.event_type).toBe("tool_use");
    expect(evt.tool_name).toBe("fn_task_list");
    expect(evt.agent_name).toBe("agent-7");
  });

  it("omits tool_name for a system message without tool metadata", () => {
    const evt = chatMessageToMemoryCaptureEvent({ role: "system", content: "x", metadata: {} });
    expect(evt.event_type).toBe("tool_use");
    expect((evt as Record<string, unknown>).tool_name).toBeUndefined();
  });
});

class FakeChatEmitter implements ChatEventEmitter {
  handlers: Record<string, Array<(...args: any[]) => void>> = {};
  on(event: string, handler: (...args: any[]) => void): unknown {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  off(event: string, handler: (...args: any[]) => void): unknown {
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== handler);
    return this;
  }
  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers[event] ?? []) handler(payload);
  }
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    sessionId: "ses-1",
    role: "user",
    content: "hello",
    thinkingOutput: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as any;
}

describe("ChatSessionMemoryCapture (deterministic chat capture service)", () => {
  beforeEach(() => {
    mockCaptureMemory.mockReset();
    mockCaptureMemory.mockResolvedValue({ ok: true, inserted: 1, deduped: 0 });
  });

  function okSink() {
    return vi.fn(async ({ events }: { events: unknown[] }) => ({
      ok: true,
      inserted: events.length,
      deduped: 0,
    }));
  }

  it("progressively emits one per-message event with session_id on chat:message:added", async () => {
    const sink = okSink();
    const service = new ChatSessionMemoryCapture({ sink: sink as any, rootDir: "/proj" });
    const emitter = new FakeChatEmitter();
    service.attach(emitter);

    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1", role: "user", content: "hi" }));
    await new Promise((resolve) => setImmediate(resolve));
    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m2", role: "assistant", content: "yo" }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(sink).toHaveBeenCalledTimes(2);
    const first = sink.mock.calls[0][0];
    expect(first.sessionId).toBe("ses-1");
    expect(first.rootDir).toBe("/proj");
    expect(first.events).toHaveLength(1);
    expect(first.events[0].event_type).toBe("user_message");
    expect(first.events[0].content).toBe("hi");
    const second = sink.mock.calls[1][0];
    expect(second.events[0].event_type).toBe("assistant_message");

    expect(service.pendingCount("ses-1")).toBe(0);
    expect(service.dispatchedCount("ses-1")).toBe(2);
  });

  it("flushes buffered messages on conversation close (session archived)", async () => {
    const sink = okSink();
    const service = new ChatSessionMemoryCapture({
      sink: sink as any,
      rootDir: "/proj",
      emitOnAdd: false,
    });
    const emitter = new FakeChatEmitter();
    service.attach(emitter);

    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1", content: "a" }));
    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m2", role: "assistant", content: "b" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink).not.toHaveBeenCalled();
    expect(service.pendingCount("ses-1")).toBe(2);

    emitter.emit(CHAT_SESSION_UPDATED, { id: "ses-1", status: "archived" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sink).toHaveBeenCalledTimes(1);
    const call = sink.mock.calls[0][0];
    expect(call.sessionId).toBe("ses-1");
    expect(call.events).toHaveLength(2);
    expect(call.events.map((e: any) => e.event_type)).toEqual(["user_message", "assistant_message"]);
    expect(service.pendingCount("ses-1")).toBe(0);
  });

  it("does not re-emit an already-appended message when the session closes", async () => {
    const sink = okSink();
    const service = new ChatSessionMemoryCapture({ sink: sink as any, rootDir: "/proj" });
    const emitter = new FakeChatEmitter();
    service.attach(emitter);

    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink).toHaveBeenCalledTimes(1);

    // Conversation close with nothing left buffered must not duplicate the earlier append.
    emitter.emit(CHAT_SESSION_UPDATED, { id: "ses-1", status: "archived" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("never throws and keeps messages buffered for retry when the sink fails", async () => {
    const sink = vi.fn(async () => {
      throw new Error("backend down");
    }) as any;
    const service = new ChatSessionMemoryCapture({ sink, rootDir: "/proj" });
    const emitter = new FakeChatEmitter();
    service.attach(emitter);

    expect(() => emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1" }))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.pendingCount("ses-1")).toBe(1);
  });

  /*
  FNXC:RUFU121SessionIdentity 2026-08-18-19:53:
  RUFU-121 Step 4: session project-identity stamping — the per-session cache is sourced from
  chat:session:updated (the ONLY message-path source of a session's projectId/title); the
  runtime identity is the fallback for sessions with no projectId of their own; a message
  before any updated event degrades to no identity without throwing; the runtime project
  name is NEVER stamped onto a cross-project session.
  */
  it("stamps the session's project identity onto the sink when chat:session:updated carries it", async () => {
    const sink = okSink();
    const service = new ChatSessionMemoryCapture({ sink: sink as any, rootDir: "/proj", emitOnAdd: false });
    const emitter = new FakeChatEmitter();
    service.attach(emitter);

    // Identity arrives on the session update BEFORE the first message flush.
    emitter.emit(CHAT_SESSION_UPDATED, { id: "ses-1", status: "active", projectId: "proj_x", title: "T" });
    await new Promise((resolve) => setImmediate(resolve));
    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1", content: "a" }));
    emitter.emit(CHAT_SESSION_UPDATED, { id: "ses-1", status: "archived", projectId: "proj_x", title: "T" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sink).toHaveBeenCalledTimes(1);
    const call = sink.mock.calls[0][0];
    expect(call.sessionId).toBe("ses-1");
    expect(call.projectId).toBe("proj_x");
    expect(call.chatTitle).toBe("T");
    expect(call.projectName ?? null).toBeNull(); // no runtime identity → no name
  });

  it("falls back to the runtime project identity when the session carries no projectId", async () => {
    const sink = okSink();
    const service = new ChatSessionMemoryCapture({
      sink: sink as any,
      rootDir: "/proj",
      emitOnAdd: false,
      projectIdentity: { projectId: "proj-rt", projectName: "Runtime Project" },
    });
    const emitter = new FakeChatEmitter();
    service.attach(emitter);

    emitter.emit(CHAT_SESSION_UPDATED, { id: "ses-1", status: "active", projectId: null, title: null });
    await new Promise((resolve) => setImmediate(resolve));
    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1", content: "a" }));
    emitter.emit(CHAT_SESSION_UPDATED, { id: "ses-1", status: "archived", projectId: null, title: null });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sink).toHaveBeenCalledTimes(1);
    const call = sink.mock.calls[0][0];
    expect(call.projectId).toBe("proj-rt");
    expect(call.projectName).toBe("Runtime Project"); // same project id → runtime name travels
    expect(call.chatTitle ?? null).toBeNull();
  });

  it("does not stamp the runtime project name onto a cross-project session", async () => {
    const sink = okSink();
    const service = new ChatSessionMemoryCapture({
      sink: sink as any,
      rootDir: "/proj",
      emitOnAdd: false,
      projectIdentity: { projectId: "proj-rt", projectName: "Runtime Project" },
    });
    const emitter = new FakeChatEmitter();
    service.attach(emitter);

    emitter.emit(CHAT_SESSION_UPDATED, { id: "ses-1", status: "active", projectId: "proj-other", title: "Other" });
    await new Promise((resolve) => setImmediate(resolve));
    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1", content: "a" }));
    emitter.emit(CHAT_SESSION_UPDATED, { id: "ses-1", status: "archived", projectId: "proj-other", title: "Other" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sink).toHaveBeenCalledTimes(1);
    const call = sink.mock.calls[0][0];
    expect(call.projectId).toBe("proj-other"); // session identity wins over the runtime fallback
    expect(call.projectName ?? null).toBeNull(); // name belongs to proj-rt, not proj-other
    expect(call.chatTitle).toBe("Other");
  });

  it("omits identity without throwing when a message arrives before any session update", async () => {
    const sink = okSink();
    const service = new ChatSessionMemoryCapture({ sink: sink as any, rootDir: "/proj" });
    const emitter = new FakeChatEmitter();
    service.attach(emitter);

    expect(() => emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1", content: "a" }))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(sink).toHaveBeenCalledTimes(1);
    const call = sink.mock.calls[0][0];
    expect(call.projectId ?? null).toBeNull();
    expect(call.projectName ?? null).toBeNull();
    expect(call.chatTitle ?? null).toBeNull();
  });

  it("is idempotent across multiple attaches and detaches cleanly", () => {
    const sink = okSink();
    const service = new ChatSessionMemoryCapture({ sink: sink as any, rootDir: "/proj" });
    const emitter = new FakeChatEmitter();
    const detach = service.attach(emitter);
    const detach2 = service.attach(emitter);
    expect(detach).toBe(detach2);
    detach();
    expect(service.pendingCount("ses-1")).toBe(0);
  });
});

describe("triggerTaskMemoryCapture (per-task completion capture)", () => {
  beforeEach(() => {
    mockCaptureMemory.mockReset();
    mockCaptureMemory.mockResolvedValue({ ok: true, inserted: 1, deduped: 0 });
  });

  it("captures a task_completion event for a stash backend using the resolved secret", async () => {
    const captured = new Set<string>();
    await triggerTaskMemoryCapture(
      {
        store: {
          getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash" }),
          getSecretsStore: async () => ({
            revealSecret: async () => ({ key: "stash-api-key", plaintextValue: "k" }),
          }),
        } as any,
        capturedMemoryTaskIds: captured,
        rootDir: "/proj",
      },
      { id: "FN-9", title: "Ship feature", status: "done" } as any,
    );

    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const [rootDir, settings, sessionId, events, meta] = mockCaptureMemory.mock.calls[0];
    expect(rootDir).toBe("/proj");
    expect(settings).toMatchObject({ memoryBackendType: "stash", stashApiKey: "k" });
    expect(sessionId).toBe("fusion-task-FN-9");
    expect(events[0]).toMatchObject({ event_type: "task_completion", content: "Ship feature" });
    expect(meta).toMatchObject({ taskId: "FN-9" });
    expect(captured.has("FN-9")).toBe(true);
  });

  it("is completion-gated: captures at most once per task", async () => {
    const captured = new Set<string>();
    const deps = {
      store: {
        getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash" }),
      } as any,
      capturedMemoryTaskIds: captured,
      rootDir: "/proj",
    };
    await triggerTaskMemoryCapture(deps, { id: "FN-9", title: "t", status: "done" } as any);
    await triggerTaskMemoryCapture(deps, { id: "FN-9", title: "t", status: "done" } as any);
    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
  });

  it("does nothing when memory capture is disabled", async () => {
    await triggerTaskMemoryCapture(
      {
        store: { getSettings: async () => ({ memoryEnabled: false }) } as any,
        capturedMemoryTaskIds: new Set<string>(),
        rootDir: "/proj",
      },
      { id: "FN-9", title: "t", status: "done" } as any,
    );
    expect(mockCaptureMemory).not.toHaveBeenCalled();
  });

  it("does nothing for a non-stash backend", async () => {
    await triggerTaskMemoryCapture(
      {
        store: { getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "qmd" }) } as any,
        capturedMemoryTaskIds: new Set<string>(),
        rootDir: "/proj",
      },
      { id: "FN-9", title: "t", status: "done" } as any,
    );
    expect(mockCaptureMemory).not.toHaveBeenCalled();
  });

  it("is non-blocking when secret resolution or capture throws", async () => {
    mockCaptureMemory.mockRejectedValue(new Error("boom"));
    await expect(
      triggerTaskMemoryCapture(
        {
          store: {
            getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash" }),
          } as any,
          capturedMemoryTaskIds: new Set<string>(),
          rootDir: "/proj",
        },
        { id: "FN-9", title: "t", status: "done" } as any,
      ),
    ).resolves.toBeUndefined();
  });

  /*
  FNXC:RUFU121TaskCaptureIdentity 2026-08-18-19:53:
  RUFU-121 Step 4: the store-derived projectId is stamped into captureMemory meta so the Stash
  backend attributes the capture to the per-project session folder (stable external_key
  fusion-<projectId>). The project name travels ONLY when the caller explicitly provides it
  (the folder resolves by external_key without a name); mock stores without getProjectId
  degrade to no identity without throwing.
  */
  it("stamps the store's projectId into captureMemory meta (store-derived fallback)", async () => {
    await triggerTaskMemoryCapture(
      {
        store: {
          getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash" }),
          getSecretsStore: async () => ({
            revealSecret: async () => ({ key: "stash-api-key", plaintextValue: "k" }),
          }),
          getProjectId: () => "proj-store",
        } as any,
        capturedMemoryTaskIds: new Set<string>(),
        rootDir: "/proj",
      },
      { id: "FN-42", title: "T", status: "done" } as any,
    );

    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const meta = mockCaptureMemory.mock.calls[0][4];
    expect(meta).toMatchObject({ taskId: "FN-42", projectId: "proj-store" });
    expect(meta.projectName).toBeUndefined();
  });

  it("stamps an explicit projectIdentity (including name) ahead of the store-derived fallback", async () => {
    await triggerTaskMemoryCapture(
      {
        store: {
          getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash" }),
          getProjectId: () => "proj-store",
        } as any,
        capturedMemoryTaskIds: new Set<string>(),
        rootDir: "/proj",
        projectIdentity: { projectId: "proj-explicit", projectName: "Explicit Name" },
      },
      { id: "FN-42", title: "T", status: "done" } as any,
    );

    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const meta = mockCaptureMemory.mock.calls[0][4];
    expect(meta).toMatchObject({ taskId: "FN-42", projectId: "proj-explicit", projectName: "Explicit Name" });
  });

  it("degrades to no project identity when the store lacks getProjectId (no throw)", async () => {
    await triggerTaskMemoryCapture(
      {
        store: {
          getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash" }),
        } as any,
        capturedMemoryTaskIds: new Set<string>(),
        rootDir: "/proj",
      },
      { id: "FN-42", title: "T", status: "done" } as any,
    );

    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const meta = mockCaptureMemory.mock.calls[0][4];
    expect(meta.projectId).toBeUndefined();
    expect(meta.projectName).toBeUndefined();
  });
});

describe("TaskExecutor signalTaskComplete per-task memory capture", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockCaptureMemory.mockReset();
    mockCaptureMemory.mockResolvedValue({ ok: true, inserted: 1, deduped: 0 });
  });

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-7528",
      description: "Test task",
      column: "in-review",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      assignedAgentId: "agent-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: "Test task",
      status: "done",
      ...overrides,
    } as any;
  }

  it("captures task memory once on completion for a stash backend and never blocks completion", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      memoryEnabled: true,
      memoryBackendType: "stash",
    });
    const onComplete = vi.fn();
    const executor = new TaskExecutor(store as any, "/tmp/test", { onComplete });

    const task = makeTask();
    (executor as any).signalTaskComplete(task);
    (executor as any).signalTaskComplete(task); // second completion must not capture twice
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("skips task memory capture when memory is disabled, still forwarding onComplete", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ memoryEnabled: false });
    const onComplete = vi.fn();
    const executor = new TaskExecutor(store as any, "/tmp/test", { onComplete });

    (executor as any).signalTaskComplete(makeTask());
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockCaptureMemory).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("attachChatMemoryCapture subscribes and detaches without throwing", () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ memoryEnabled: true, memoryBackendType: "stash" });
    const executor = new TaskExecutor(store as any, "/tmp/test", {});

    const emitter = new FakeChatEmitter();
    const detach = executor.attachChatMemoryCapture(emitter as any);
    expect(typeof detach).toBe("function");
    emitter.emit(CHAT_MESSAGE_ADDED, makeMessage({ id: "m1", sessionId: "ses-x" }));
    expect(() => detach()).not.toThrow();
  });
});
/*
FNXC:RUFU121StashSinkIdentity 2026-08-18-19:53:
RUFU-121 Step 4: the stash sink factory threads the effective project identity into captureMemory's
meta when the caller supplies it via the sink params (the ChatSessionMemoryCapture path), and
falls back to the factory-level identity when the params carry none. Existing per-flush
settings+secret resolution behavior is preserved.
*/
describe("createStashChatMemoryCaptureSink (RUFU-121 Step 4 identity threading)", () => {
  beforeEach(() => {
    mockCaptureMemory.mockReset();
    mockCaptureMemory.mockResolvedValue({ ok: true, inserted: 1, deduped: 0 });
  });

  function stashStore() {
    return {
      getSettings: async () => ({ memoryEnabled: true, memoryBackendType: "stash", stashUrl: "http://127.0.0.1:3457" }),
      getSecretsStore: async () => ({
        revealSecret: async () => ({ key: "stash-api-key", plaintextValue: "k" }),
      }),
    } as any;
  }

  it("threads the caller-supplied identity into captureMemory meta", async () => {
    const sink = createStashChatMemoryCaptureSink(stashStore());
    await sink({
      sessionId: "ses-1",
      events: [chatMessageToMemoryCaptureEvent({ role: "user", content: "hi", metadata: null })],
      rootDir: "/proj",
      projectId: "proj_x",
      projectName: "Proj X",
      chatTitle: "T",
    });

    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const meta = mockCaptureMemory.mock.calls[0][4];
    expect(meta).toMatchObject({ projectRoot: "/proj", projectId: "proj_x", projectName: "Proj X", chatTitle: "T" });
  });

  it("falls back to the factory-level identity when the sink params carry none", async () => {
    const sink = createStashChatMemoryCaptureSink(stashStore(), { projectId: "proj-rt", projectName: "Runtime" });
    await sink({
      sessionId: "ses-1",
      events: [chatMessageToMemoryCaptureEvent({ role: "user", content: "hi", metadata: null })],
      rootDir: "/proj",
    });

    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const meta = mockCaptureMemory.mock.calls[0][4];
    expect(meta).toMatchObject({ projectId: "proj-rt", projectName: "Runtime" });
  });

  it("omits all identity meta when neither params nor factory identity provide any", async () => {
    const sink = createStashChatMemoryCaptureSink(stashStore());
    await sink({
      sessionId: "ses-1",
      events: [chatMessageToMemoryCaptureEvent({ role: "user", content: "hi", metadata: null })],
      rootDir: "/proj",
    });

    expect(mockCaptureMemory).toHaveBeenCalledTimes(1);
    const meta = mockCaptureMemory.mock.calls[0][4];
    expect(meta).toMatchObject({ projectRoot: "/proj" });
    expect(meta.projectId).toBeUndefined();
    expect(meta.projectName).toBeUndefined();
    expect(meta.chatTitle).toBeUndefined();
  });
});
