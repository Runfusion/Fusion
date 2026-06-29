import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MergeResult } from "@fusion/core";
import {
  NtfyNotifier,
  DEFAULT_NTFY_EVENTS,
  buildNtfyClickUrl,
  isNtfyEventEnabled,
  resolveNtfyEvents,
  sendNtfyNotificationWithResult,
} from "../notifier.js";
import { NtfyNotificationProvider } from "../notification/ntfy-provider.js";
import { MockTaskStore, createTask, flushAsyncWork } from "./notifier.test-harness.js";

vi.mock("../logger.js", () => ({
  schedulerLog: { log: vi.fn(), error: vi.fn() },
}));

describe("Ntfy notifier helpers", () => {
  it("includes mailbox message events in default events", () => {
    expect(DEFAULT_NTFY_EVENTS).toContain("planning-awaiting-input");
    expect(resolveNtfyEvents(undefined)).toContain("planning-awaiting-input");
    expect(DEFAULT_NTFY_EVENTS).toContain("cli-agent-awaiting-input");
    expect(resolveNtfyEvents(undefined)).toContain("cli-agent-awaiting-input");
    expect(DEFAULT_NTFY_EVENTS).toContain("gridlock");
    expect(DEFAULT_NTFY_EVENTS).toContain("fallback-used");
    expect(DEFAULT_NTFY_EVENTS).toContain("message:agent-to-user");
    expect(DEFAULT_NTFY_EVENTS).toContain("message:agent-to-agent");
    expect(DEFAULT_NTFY_EVENTS).toContain("message:room");
    expect(DEFAULT_NTFY_EVENTS).toContain("workflow-notify");
  });

  it("checks awaiting-input event enablement", () => {
    expect(isNtfyEventEnabled(["planning-awaiting-input"], "planning-awaiting-input")).toBe(true);
    expect(isNtfyEventEnabled(["failed"], "planning-awaiting-input")).toBe(false);
    expect(isNtfyEventEnabled(["cli-agent-awaiting-input"], "cli-agent-awaiting-input")).toBe(true);
    expect(isNtfyEventEnabled(["failed"], "cli-agent-awaiting-input")).toBe(false);
  });

  it("supports task-created enablement while keeping it default-off", () => {
    expect(isNtfyEventEnabled(["task-created"], "task-created")).toBe(true);
    expect(DEFAULT_NTFY_EVENTS).not.toContain("task-created");
  });

  it("builds project dashboard root links without task id", () => {
    expect(buildNtfyClickUrl({ dashboardHost: "http://localhost:4040/", projectId: "proj-1" })).toBe(
      "http://localhost:4040/?project=proj-1",
    );
  });

  it("builds task message deep links", () => {
    expect(
      buildNtfyClickUrl({
        dashboardHost: "http://localhost:4040/",
        projectId: "proj-1",
        taskId: "FN-1",
        messageId: "msg-1",
      }),
    ).toBe("http://localhost:4040/?project=proj-1&task=FN-1#message-msg-1");
  });

  it("builds standalone mailbox message deep links", () => {
    expect(
      buildNtfyClickUrl({
        dashboardHost: "http://localhost:4040/",
        projectId: "proj-1",
        messageId: "msg-1",
      }),
    ).toBe("http://localhost:4040/?project=proj-1&view=mailbox&mailbox-message=msg-1#message-msg-1");
  });

  it("builds room message deep links", () => {
    expect(
      buildNtfyClickUrl({
        dashboardHost: "http://localhost:4040/",
        projectId: "proj-1",
        roomId: "room-1",
        messageId: "msg-1",
        view: "rooms",
      }),
    ).toBe("http://localhost:4040/?project=proj-1&view=rooms&room=room-1#message-msg-1");
  });
});

describe("sendNtfyNotificationWithResult", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useRealTimers();
    fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      new Headers(init?.headers);
      return { ok: true, status: 200, statusText: "OK" } as Response;
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calling with a unicode title does not throw and posts JSON with auth preserved", async () => {
    const signal = new AbortController().signal;

    await expect(sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      ntfyAccessToken: "secret-token",
      topic: "test-topic",
      title: "Triage Bot → Executor Bot",
      message: "Triage Bot → you: preview text",
      clickUrl: "https://fusion.example.com/?task=FN-1",
      signal,
    })).resolves.toEqual({ ok: true, status: 200, statusText: "OK" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.sh/",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        }),
      }),
    );

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(request.headers as HeadersInit);
    expect(headers.has("Priority")).toBe(false);
    expect(JSON.parse(String(request.body))).toEqual({
      topic: "test-topic",
      title: "Triage Bot → Executor Bot",
      message: "Triage Bot → you: preview text",
      priority: 3,
      click: "https://fusion.example.com/?task=FN-1",
    });
  });

  it("maps JSON publish priority names to integer values", async () => {
    const cases = [
      { priority: "low", expected: 2 },
      { priority: "default", expected: 3 },
      { priority: "high", expected: 4 },
      { priority: "urgent", expected: 5 },
    ] as const;

    for (const testCase of cases) {
      await sendNtfyNotificationWithResult({
        ntfyBaseUrl: "https://ntfy.sh",
        topic: "json-priority-topic",
        title: "Sender → Receiver",
        message: "Unicode path exercises JSON publish",
        priority: testCase.priority,
      });

      const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
      const payload = JSON.parse(String(request.body)) as { priority: number };
      expect(payload.priority).toBe(testCase.expected);
    }
  });

  it("keeps string Priority header for latin1-safe publishes", async () => {
    await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "header-priority-topic",
      title: "ASCII title",
      message: "ASCII message",
      priority: "high",
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(request.headers as HeadersInit);
    expect(headers.get("Priority")).toBe("high");
  });

  it("sends message inbox notifications with integer JSON priority via provider", async () => {
    const provider = new NtfyNotificationProvider();
    await provider.initialize({
      topic: "provider-topic",
      ntfyBaseUrl: "https://ntfy.sh",
      events: ["message:agent-to-user"],
    });

    const result = await provider.sendNotification("message:agent-to-user", {
      event: "message:agent-to-user",
      taskId: "FN-1",
      metadata: {
        fromName: "Triage Bot",
        toName: "you",
        preview: "Hello from queue",
      },
    });

    expect(result.success).toBe(true);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as { priority: number; message: string };
    expect(payload.priority).toBe(4);
    expect(payload.message).toContain("→");

    await provider.shutdown();
  });

  it("keeps the legacy text/plain header path for pure ASCII titles", async () => {
    const signal = new AbortController().signal;

    await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "ascii-topic",
      title: "Task FN-1 merged",
      message: "Task \"Example\" has been merged to main",
      clickUrl: "https://fusion.example.com/?task=FN-1",
      signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.sh/ascii-topic",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          "Content-Type": "text/plain",
          Title: "Task FN-1 merged",
          Priority: "default",
          Click: "https://fusion.example.com/?task=FN-1",
        }),
        body: "Task \"Example\" has been merged to main",
      }),
    );
  });

  it("does not retry when the first ntfy publish succeeds", async () => {
    const result = await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "single-success",
      title: "Task FN-1 merged",
      message: "Task merged",
      retryDelayMs: 0,
    });

    expect(result).toEqual({ ok: true, status: 200, statusText: "OK" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries retryable network failures and returns the recovered success", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" } as Response);

    const result = await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      ntfyAccessToken: "secret-token",
      topic: "retry-topic",
      title: "ASCII title",
      message: "ASCII message",
      retryDelayMs: 0,
    });

    expect(result).toEqual({ ok: true, status: 200, statusText: "OK" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const request = call[1] as RequestInit;
      const headers = new Headers(request.headers as HeadersInit);
      expect(headers.get("Authorization")).toBe("Bearer secret-token");
      expect(call[0]).toBe("https://ntfy.sh/retry-topic");
    }
  });

  it.each([
    { status: 503, statusText: "Service Unavailable" },
    { status: 429, statusText: "Too Many Requests" },
  ])("retries retryable HTTP status $status", async ({ status, statusText }) => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status, statusText } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" } as Response);

    const result = await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "http-retry-topic",
      title: "ASCII title",
      message: "ASCII message",
      retryDelayMs: 0,
    });

    expect(result).toEqual({ ok: true, status: 200, statusText: "OK" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 400, statusText: "Bad Request" },
    { status: 401, statusText: "Unauthorized" },
    { status: 403, statusText: "Forbidden" },
    { status: 404, statusText: "Not Found" },
  ])("does not retry non-429 client status $status", async ({ status, statusText }) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status, statusText } as Response);

    const result = await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "client-error-topic",
      title: "ASCII title",
      message: "ASCII message",
      retryDelayMs: 0,
    });

    expect(result).toEqual({ ok: false, status, statusText });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the last HTTP failure after exhausting retryable responses", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "first" } as Response)
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "second" } as Response);

    const result = await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "exhaust-http-topic",
      title: "ASCII title",
      message: "ASCII message",
      retryDelayMs: 0,
      maxAttempts: 2,
    });

    expect(result).toEqual({ ok: false, status: 503, statusText: "second" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null without throwing after exhausting network retries", async () => {
    fetchMock.mockRejectedValue(new Error("DNS failure"));

    await expect(sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "network-fail-topic",
      title: "ASCII title",
      message: "ASCII message",
      retryDelayMs: 0,
      maxAttempts: 2,
    })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung attempt with the per-attempt timeout and retries", async () => {
    vi.useFakeTimers();
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock
      .mockImplementationOnce((_input: string | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError), { once: true });
      }))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" } as Response);

    const resultPromise = sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "timeout-topic",
      title: "ASCII title",
      message: "ASCII message",
      attemptTimeoutMs: 5,
      retryDelayMs: 0,
      maxAttempts: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5);
    await expect(resultPromise).resolves.toEqual({ ok: true, status: 200, statusText: "OK" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("returns null after every attempt times out", async () => {
    vi.useFakeTimers();
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockImplementation((_input: string | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError), { once: true });
    }));

    const resultPromise = sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "timeout-null-topic",
      title: "ASCII title",
      message: "ASCII message",
      attemptTimeoutMs: 5,
      retryDelayMs: 0,
      maxAttempts: 2,
    });

    await vi.advanceTimersByTimeAsync(5);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5);
    await expect(resultPromise).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("short-circuits without fetch when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "aborted-topic",
      title: "ASCII title",
      message: "ASCII message",
      signal: controller.signal,
      retryDelayMs: 0,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry after a caller aborts mid-flight", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fetchMock.mockImplementationOnce((_input: string | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError), { once: true });
    }));

    const resultPromise = sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "caller-abort-topic",
      title: "ASCII title",
      message: "ASCII message",
      signal: controller.signal,
      retryDelayMs: 0,
    });

    controller.abort();

    await expect(resultPromise).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts unicode retries through the JSON publish path", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" } as Response);

    const result = await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "unicode-topic",
      title: "Triage Bot → Executor Bot",
      message: "Triage Bot → you: preview text",
      priority: "high",
      retryDelayMs: 0,
    });

    expect(result).toEqual({ ok: true, status: 200, statusText: "OK" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://ntfy.sh/");
      const request = call[1] as RequestInit;
      const payload = JSON.parse(String(request.body)) as { topic: string; priority: number; message: string };
      expect(new Headers(request.headers as HeadersInit).get("Content-Type")).toBe("application/json");
      expect(payload).toEqual(expect.objectContaining({
        topic: "unicode-topic",
        priority: 4,
        message: "Triage Bot → you: preview text",
      }));
    }
  });

  it("lets the provider report success when the primitive retry recovers", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" } as Response);
    const provider = new NtfyNotificationProvider();
    await provider.initialize({
      topic: "provider-retry-topic",
      ntfyBaseUrl: "https://ntfy.sh",
      events: ["in-review"],
    });

    const result = await provider.sendNotification("in-review", {
      taskId: "FN-1",
      taskTitle: "Retry me",
      event: "in-review",
    });

    expect(result).toEqual({ success: true, providerId: "ntfy" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await provider.shutdown();
  });

  it("truncates overlong titles to 250 characters with an ellipsis", async () => {
    await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "test-topic",
      title: `${"T".repeat(260)}→`,
      message: "Preview text",
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as { title: string };
    expect(Array.from(payload.title)).toHaveLength(250);
    expect(payload.title.endsWith("…")).toBe(true);
  });

  it("truncates overlong messages to fit within 4096 UTF-8 bytes with an ellipsis", async () => {
    await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "test-topic",
      title: "Triage Bot → Executor Bot",
      message: "é".repeat(3000),
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as { message: string };
    expect(Buffer.byteLength(payload.message, "utf8")).toBeLessThanOrEqual(4096);
    expect(payload.message.endsWith("…")).toBe(true);
  });

  it("does not split a surrogate pair when truncating overlong messages", async () => {
    await sendNtfyNotificationWithResult({
      ntfyBaseUrl: "https://ntfy.sh",
      topic: "test-topic",
      title: "Triage Bot → Executor Bot",
      message: `${"𝐀".repeat(1024)}Z`,
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as { message: string };
    const characters = Array.from(payload.message);
    expect(Buffer.byteLength(payload.message, "utf8")).toBeLessThanOrEqual(4096);
    expect(characters.at(-1)).toBe("…");
    expect(characters.at(-2)).toBe("𝐀");
    expect(payload.message.endsWith("𝐀…")).toBe(true);
    expect(payload.message).not.toContain("�");
  });
});

describe("NtfyNotifier", () => {
  let store: MockTaskStore;
  let notifier: NtfyNotifier;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    store = new MockTaskStore();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    if (notifier) {
      notifier.stop();
    }
    vi.restoreAllMocks();
  });

  describe("when disabled", () => {
    it("does not send any notifications when ntfyEnabled is false", async () => {
      store.setSettings({ ntfyEnabled: false, ntfyTopic: "my-topic" });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");

      // Wait for any async operations
      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send notifications when ntfyTopic is not set", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: undefined });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");

      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("gridlock notifications", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends notification when gridlock event is enabled", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["gridlock"] });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store, { projectId: "proj-1" });
      await notifier.start();

      notifier.notifyGridlock({
        blockedTaskCount: 2,
        reasons: { "FN-001": "dependency", "FN-003": "overlap" },
        blockedTaskIds: ["FN-001", "FN-003"],
        blockingTaskIds: ["FN-002"],
      });

      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Title: "Pipeline gridlocked",
            Priority: "high",
          }),
        }),
      );
    });

    it("skips notification when gridlock event is disabled", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["failed"] });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      notifier.notifyGridlock({
        blockedTaskCount: 1,
        reasons: { "FN-001": "dependency" },
        blockedTaskIds: ["FN-001"],
        blockingTaskIds: ["FN-002"],
      });

      await flushAsyncWork();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("suppresses repeated gridlock notifications during the 15-minute cooldown even when blocked set changes", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["gridlock"] });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      notifier.notifyGridlock({
        blockedTaskCount: 2,
        reasons: { "FN-001": "dependency", "FN-003": "dependency" },
        blockedTaskIds: ["FN-003", "FN-001"],
        blockingTaskIds: ["FN-002"],
      });

      vi.advanceTimersByTime(5 * 60 * 1000);
      notifier.notifyGridlock({
        blockedTaskCount: 3,
        reasons: { "FN-001": "dependency", "FN-003": "dependency", "FN-004": "overlap" },
        blockedTaskIds: ["FN-001", "FN-003", "FN-004"],
        blockingTaskIds: ["FN-002", "FN-005"],
      });

      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows a new gridlock notification immediately after resolution reset", async () => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic", ntfyEvents: ["gridlock"] });
      fetchMock.mockResolvedValue({ ok: true });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      notifier.notifyGridlock({
        blockedTaskCount: 1,
        reasons: { "FN-001": "dependency" },
        blockedTaskIds: ["FN-001"],
        blockingTaskIds: ["FN-002"],
      });

      vi.advanceTimersByTime(60_000);
      notifier.notifyGridlock(null);
      notifier.notifyGridlock({
        blockedTaskCount: 1,
        reasons: { "FN-009": "overlap" },
        blockedTaskIds: ["FN-009"],
        blockingTaskIds: ["FN-010"],
      });

      await flushAsyncWork();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("when enabled", () => {
    beforeEach(() => {
      store.setSettings({ ntfyEnabled: true, ntfyTopic: "test-topic" });
      fetchMock.mockResolvedValue({ ok: true });
    });

    it("sends notification when task moves to in-review", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Task FN-001 completed",
            "Priority": "default",
          }),
          body: 'Task "Test Task" is ready for review',
        })
      );
    });

    it("does not send notification when task moves to done (merged notification comes from task:merged)", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-review", "done");

      await flushAsyncWork();

      // handleTaskMoved should NOT send notification for "done" - that's handleTaskMerged's job
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends high priority notification when task fails", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const failedTask = createTask("FN-001", "Test Task", "failed");
      store.triggerTaskUpdated(failedTask);

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Task FN-001 failed",
            "Priority": "high",
          }),
          body: 'Task "Test Task" has failed and needs attention',
        })
      );
    });

    it("sends high priority notification when task is awaiting approval", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const awaitingApprovalTask = createTask("FN-002", "Spec Task", "awaiting-approval");
      store.triggerTaskUpdated(awaitingApprovalTask);

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Plan needs approval for FN-002",
            "Priority": "high",
          }),
          body: 'Task "Spec Task" needs your approval before it can proceed',
        })
      );
    });

    it("sends high priority notification when task needs user review", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const awaitingUserReviewTask = createTask("FN-003", "Review Task", "awaiting-user-review");
      store.triggerTaskUpdated(awaitingUserReviewTask);

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "User review needed for FN-003",
            "Priority": "high",
          }),
          body: 'Task "Review Task" needs human review before it can proceed',
        })
      );
    });

    it("sends notification when task is merged", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const mergeResult: MergeResult = {
        task: createTask("FN-001", "Test Task"),
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };
      store.triggerTaskMerged(mergeResult);

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Title": "Task FN-001 merged",
            "Priority": "default",
          }),
          body: 'Task "Test Task" has been merged to main',
        })
      );
    });

    it("does not send notification for failed merges", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const mergeResult: MergeResult = {
        task: createTask("FN-001", "Test Task"),
        branch: "fusion/fn-001",
        merged: false,
        worktreeRemoved: false,
        branchDeleted: false,
        error: "Merge conflict",
      };
      store.triggerTaskMerged(mergeResult);

      await flushAsyncWork();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uses task ID and description when title is not available", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const taskWithoutTitle = { ...createTask("FN-001"), description: "Implement user authentication flow" };
      store.triggerTaskMoved(taskWithoutTitle, "in-progress", "in-review");

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          body: 'Task "FN-001: Implement user authentication flow" is ready for review',
        })
      );
    });

    it("truncates description to 200 characters when no title is set", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const longDescription = "A".repeat(250);
      const taskWithoutTitle = { ...createTask("FN-001"), description: longDescription };
      store.triggerTaskMoved(taskWithoutTitle, "in-progress", "in-review");

      await flushAsyncWork();

      const expectedSnippet = "A".repeat(200) + "...";
      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          body: `Task "FN-001: ${expectedSnippet}" is ready for review`,
        })
      );
    });

    it("does not truncate description at exactly 200 characters", async () => {
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const exactDescription = "B".repeat(200);
      const taskWithoutTitle = { ...createTask("FN-001"), description: exactDescription };
      store.triggerTaskMoved(taskWithoutTitle, "in-progress", "in-review");

      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          body: `Task "FN-001: ${exactDescription}" is ready for review`,
        })
      );
    });
  });

  describe("deep link (Click header)", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue({ ok: true });
    });

    it("includes Click header with task URL when ntfyDashboardHost is set", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "https://fusion.example.com/?task=FN-001",
          }),
        })
      );
    });

    it("does not include Click header when ntfyDashboardHost is not set", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: undefined,
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      const callArgs = fetchMock.mock.calls[0][1];
      expect(callArgs.headers).not.toHaveProperty("Click");
    });

    it("handles hostname with trailing slash correctly", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000/",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-042", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?task=FN-042",
          }),
        })
      );
    });

    it("handles hostname without trailing slash correctly", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-042", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?task=FN-042",
          }),
        })
      );
    });

    it("includes Click header for failed task notifications when dashboard host is set", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const failedTask = createTask("FN-001", "Test Task", "failed");
      store.triggerTaskUpdated(failedTask);
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "https://fusion.example.com/?task=FN-001",
          }),
        })
      );
    });

    it("includes Click header for awaiting-approval notifications when dashboard host is set", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const awaitingApprovalTask = createTask("FN-002", "Spec Task", "awaiting-approval");
      store.triggerTaskUpdated(awaitingApprovalTask);
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "https://fusion.example.com/?task=FN-002",
          }),
        })
      );
    });

    it("includes Click header for awaiting-user-review notifications when dashboard host is set", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const awaitingUserReviewTask = createTask("FN-003", "Review Task", "awaiting-user-review");
      store.triggerTaskUpdated(awaitingUserReviewTask);
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "https://fusion.example.com/?task=FN-003",
          }),
        })
      );
    });

    it("includes Click header for merged task notifications when dashboard host is set", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      const mergeResult: MergeResult = {
        task: createTask("FN-001", "Test Task"),
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };
      store.triggerTaskMerged(mergeResult);
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "https://fusion.example.com/?task=FN-001",
          }),
        })
      );
    });

    it("encodes task IDs with special characters in Click URL", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001/test", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?task=FN-001%2Ftest",
          }),
        })
      );
    });
  });

  describe("project ID in URLs", () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue({ ok: true });
    });

    it("includes projectId in Click URL when configured for in-review notifications", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000",
      });
      notifier = new NtfyNotifier(store, { projectId: "proj_123" });
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?project=proj_123&task=FN-001",
          }),
        })
      );
    });

    it("includes projectId in Click URL when configured for failed task notifications", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });
      notifier = new NtfyNotifier(store, { projectId: "my-project" });
      await notifier.start();

      const failedTask = createTask("FN-001", "Test Task", "failed");
      store.triggerTaskUpdated(failedTask);
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "https://fusion.example.com/?project=my-project&task=FN-001",
          }),
        })
      );
    });

    it("includes projectId in Click URL when configured for merged task notifications", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });
      notifier = new NtfyNotifier(store, { projectId: "another-project" });
      await notifier.start();

      const mergeResult: MergeResult = {
        task: createTask("FN-001", "Test Task"),
        branch: "fusion/fn-001",
        merged: true,
        worktreeRemoved: true,
        branchDeleted: true,
      };
      store.triggerTaskMerged(mergeResult);
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "https://fusion.example.com/?project=another-project&task=FN-001",
          }),
        })
      );
    });

    it("includes projectId in Click URL when configured for awaiting-user-review notifications", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "https://fusion.example.com",
      });
      notifier = new NtfyNotifier(store, { projectId: "user-review-project" });
      await notifier.start();

      const awaitingUserReviewTask = createTask("FN-001", "Test Task", "awaiting-user-review");
      store.triggerTaskUpdated(awaitingUserReviewTask);
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "https://fusion.example.com/?project=user-review-project&task=FN-001",
          }),
        })
      );
    });

    it("falls back to task-only URL when projectId not configured", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000",
      });
      notifier = new NtfyNotifier(store);
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?task=FN-001",
          }),
        })
      );
    });

    it("encodes special characters in projectId", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000",
      });
      notifier = new NtfyNotifier(store, { projectId: "proj/abc" });
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?project=proj%2Fabc&task=FN-001",
          }),
        })
      );
    });

    it("handles projectId with spaces and special characters", async () => {
      store.setSettings({
        ntfyEnabled: true,
        ntfyTopic: "test-topic",
        ntfyDashboardHost: "http://localhost:3000",
      });
      notifier = new NtfyNotifier(store, { projectId: "my project test" });
      await notifier.start();

      store.triggerTaskMoved(createTask("FN-001", "Test Task"), "in-progress", "in-review");
      await flushAsyncWork();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://ntfy.sh/test-topic",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Click": "http://localhost:3000/?project=my%20project%20test&task=FN-001",
          }),
        })
      );
    });
  });

});
