import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipRuntimeAdapter } from "../runtime-adapter.js";

const {
  mockCreateIssue,
  mockCheckoutIssue,
  mockInvokeHeartbeat,
  mockGetIssue,
  mockGetIssueComments,
  MockConflictError,
} = vi.hoisted(() => {
  class LocalConflictError extends Error {
    readonly status = 409;
  }

  return {
    mockCreateIssue: vi.fn(),
    mockCheckoutIssue: vi.fn(),
    mockInvokeHeartbeat: vi.fn(),
    mockGetIssue: vi.fn(),
    mockGetIssueComments: vi.fn(),
    MockConflictError: LocalConflictError,
  };
});

vi.mock("../pi-module.js", () => ({
  resolvePaperclipConfig: vi.fn((settings?: Record<string, unknown>) => ({
    apiUrl: "http://localhost:3100",
    apiKey: undefined,
    agentId: undefined,
    companyId: undefined,
    ...(settings ?? {}),
  })),
  createIssue: mockCreateIssue,
  checkoutIssue: mockCheckoutIssue,
  invokeHeartbeat: mockInvokeHeartbeat,
  getIssue: mockGetIssue,
  getIssueComments: mockGetIssueComments,
  ConflictError: MockConflictError,
}));

describe("PaperclipRuntimeAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createSession returns configured Paperclip session with undefined sessionFile", async () => {
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const adapter = new PaperclipRuntimeAdapter({
      apiUrl: "http://paperclip.local",
      apiKey: "token",
      agentId: "AG-1",
      companyId: "CO-1",
    });

    const { session, sessionFile } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "system",
      onText,
      onThinking,
      onToolStart,
      onToolEnd,
    });

    expect(sessionFile).toBeUndefined();
    expect(session).toMatchObject({
      apiUrl: "http://paperclip.local",
      apiKey: "token",
      agentId: "AG-1",
      companyId: "CO-1",
      cwd: "/repo",
      systemPrompt: "system",
      onText,
      onThinking,
      onToolStart,
      onToolEnd,
    });
    expect(session.sessionId).toBeTypeOf("string");
  });

  it("createSession throws when required agentId/companyId config is missing", async () => {
    const adapter = new PaperclipRuntimeAdapter({ apiUrl: "http://paperclip.local" });

    await expect(
      adapter.createSession({
        cwd: "/repo",
        systemPrompt: "system",
      }),
    ).rejects.toThrow("missing required config");
  });

  it("promptWithFallback creates issue, checks out, invokes heartbeat, polls, and emits output", async () => {
    vi.useFakeTimers();

    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const adapter = new PaperclipRuntimeAdapter({
      apiUrl: "http://paperclip.local",
      apiKey: "token",
      agentId: "AG-1",
      companyId: "CO-1",
    });

    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "system prompt",
      onText,
      onThinking,
      onToolStart,
      onToolEnd,
    });

    mockCreateIssue.mockResolvedValue({ id: "ISS-1", status: "backlog" });
    mockCheckoutIssue.mockResolvedValue({ id: "ISS-1", status: "in_progress" });
    mockInvokeHeartbeat.mockResolvedValue({ ok: true, run: { id: "RUN-1", status: "queued" } });
    mockGetIssue
      .mockResolvedValueOnce({ id: "ISS-1", status: "in_progress" })
      .mockResolvedValueOnce({ id: "ISS-1", status: "done" });
    mockGetIssueComments.mockResolvedValue([
      { id: "C1", body: "Thinking: I should do this" },
      { id: "C2", body: "Completed work." },
    ]);

    const promptPromise = adapter.promptWithFallback(session, "Title line\nBody");
    await vi.advanceTimersByTimeAsync(6_000);
    await promptPromise;

    expect(mockCreateIssue).toHaveBeenCalledWith(
      "http://paperclip.local",
      "token",
      "CO-1",
      expect.objectContaining({
        title: "Title line",
        status: "backlog",
        assigneeAgentId: "AG-1",
      }),
    );
    expect(mockCheckoutIssue).toHaveBeenCalledWith(
      "http://paperclip.local",
      "token",
      "ISS-1",
      "AG-1",
      expect.any(String),
    );
    expect(mockInvokeHeartbeat).toHaveBeenCalledWith("http://paperclip.local", "token", "AG-1");
    expect(onText).toHaveBeenCalledWith("Thinking: I should do this\n\nCompleted work.");
    expect(onThinking).toHaveBeenCalledWith("I should do this");
    expect(onToolStart).toHaveBeenCalledWith(
      "paperclip.issue",
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
    expect(onToolEnd).toHaveBeenCalledWith("paperclip.issue", false, {
      issueId: "ISS-1",
      status: "done",
    });
  });

  it("handles checkout conflicts gracefully and continues", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const adapter = new PaperclipRuntimeAdapter(
      {
        apiUrl: "http://paperclip.local",
        apiKey: "token",
        agentId: "AG-1",
        companyId: "CO-1",
      },
      logger,
    );

    const { session } = await adapter.createSession({ cwd: "/repo", systemPrompt: "system" });

    mockCreateIssue.mockResolvedValue({ id: "ISS-1", status: "backlog" });
    mockCheckoutIssue.mockRejectedValue(new MockConflictError("conflict"));
    mockInvokeHeartbeat.mockResolvedValue({ ok: true, skipped: true });
    mockGetIssue.mockResolvedValue({ id: "ISS-1", status: "done" });
    mockGetIssueComments.mockResolvedValue([{ body: "done" }]);

    const promise = adapter.promptWithFallback(session, "Prompt");
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("checkout conflict"));
    expect(mockInvokeHeartbeat).toHaveBeenCalled();
  });

  it("handles heartbeat skipped responses and continues polling", async () => {
    vi.useFakeTimers();

    const adapter = new PaperclipRuntimeAdapter({
      apiUrl: "http://paperclip.local",
      apiKey: "token",
      agentId: "AG-1",
      companyId: "CO-1",
    });

    const { session } = await adapter.createSession({ cwd: "/repo", systemPrompt: "system" });

    mockCreateIssue.mockResolvedValue({ id: "ISS-1", status: "backlog" });
    mockCheckoutIssue.mockResolvedValue({ id: "ISS-1", status: "in_progress" });
    mockInvokeHeartbeat.mockResolvedValue({ ok: true, skipped: true });
    mockGetIssue.mockResolvedValue({ id: "ISS-1", status: "done" });
    mockGetIssueComments.mockResolvedValue([{ body: "done" }]);

    const promise = adapter.promptWithFallback(session, "Prompt");
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(mockInvokeHeartbeat).toHaveBeenCalled();
    expect(mockGetIssue).toHaveBeenCalled();
  });

  it("returns output on timeout with whatever comments are available", async () => {
    vi.useFakeTimers();
    const onText = vi.fn();

    const adapter = new PaperclipRuntimeAdapter({
      apiUrl: "http://paperclip.local",
      apiKey: "token",
      agentId: "AG-1",
      companyId: "CO-1",
    });

    const { session } = await adapter.createSession({ cwd: "/repo", systemPrompt: "system", onText });

    mockCreateIssue.mockResolvedValue({ id: "ISS-1", status: "backlog" });
    mockCheckoutIssue.mockResolvedValue({ id: "ISS-1", status: "in_progress" });
    mockInvokeHeartbeat.mockResolvedValue({ ok: true, run: { id: "RUN-1", status: "queued" } });
    mockGetIssue.mockResolvedValue({ id: "ISS-1", status: "in_progress" });
    mockGetIssueComments.mockResolvedValue([{ body: "partial result" }]);

    const promise = adapter.promptWithFallback(session, "Prompt");
    await vi.advanceTimersByTimeAsync(130_000);
    await promise;

    expect(onText).toHaveBeenCalledWith("partial result");
  });

  it("uses exponential backoff intervals while polling", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const adapter = new PaperclipRuntimeAdapter({
      apiUrl: "http://paperclip.local",
      apiKey: "token",
      agentId: "AG-1",
      companyId: "CO-1",
    });

    const { session } = await adapter.createSession({ cwd: "/repo", systemPrompt: "system" });

    mockCreateIssue.mockResolvedValue({ id: "ISS-1", status: "backlog" });
    mockCheckoutIssue.mockResolvedValue({ id: "ISS-1", status: "in_progress" });
    mockInvokeHeartbeat.mockResolvedValue({ ok: true, run: { id: "RUN-1", status: "queued" } });
    mockGetIssue
      .mockResolvedValueOnce({ id: "ISS-1", status: "in_progress" })
      .mockResolvedValueOnce({ id: "ISS-1", status: "in_progress" })
      .mockResolvedValueOnce({ id: "ISS-1", status: "in_progress" })
      .mockResolvedValueOnce({ id: "ISS-1", status: "in_progress" })
      .mockResolvedValueOnce({ id: "ISS-1", status: "done" });
    mockGetIssueComments.mockResolvedValue([{ body: "done" }]);

    const promise = adapter.promptWithFallback(session, "Prompt");
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 10_000 + 10_000);
    await promise;

    const timeoutDurations = timeoutSpy.mock.calls.map((call) => call[1]).filter((value) => typeof value === "number");
    expect(timeoutDurations).toEqual(expect.arrayContaining([2_000, 4_000, 8_000, 10_000]));
  });

  it("describeModel returns paperclip/<agentId>", async () => {
    const adapter = new PaperclipRuntimeAdapter({
      apiUrl: "http://paperclip.local",
      agentId: "AG-1",
      companyId: "CO-1",
    });

    const { session } = await adapter.createSession({ cwd: "/repo", systemPrompt: "system" });
    expect(adapter.describeModel(session)).toBe("paperclip/AG-1");
  });

  it("dispose is a no-op", async () => {
    const adapter = new PaperclipRuntimeAdapter({
      apiUrl: "http://paperclip.local",
      agentId: "AG-1",
      companyId: "CO-1",
    });

    const { session } = await adapter.createSession({ cwd: "/repo", systemPrompt: "system" });
    expect(typeof session.dispose).toBe("function");
    expect(() => session.dispose?.()).not.toThrow();
    await expect(adapter.dispose(session)).resolves.toBeUndefined();
  });
});
