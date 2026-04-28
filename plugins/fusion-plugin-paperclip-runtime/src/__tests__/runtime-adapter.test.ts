import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipRuntimeAdapter } from "../runtime-adapter.js";
import type { RunEvent } from "../paperclip-client.js";

const {
  mockAgentsMe,
  mockCreateIssue,
  mockGetIssue,
  mockGetIssueComments,
  mockGetRunEvents,
  mockWakeAgent,
  mockResolveConfig,
} = vi.hoisted(() => ({
  mockAgentsMe: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockGetIssue: vi.fn(),
  mockGetIssueComments: vi.fn(),
  mockGetRunEvents: vi.fn(),
  mockWakeAgent: vi.fn(),
  mockResolveConfig: vi.fn((settings?: Record<string, unknown>) => ({
    apiUrl: "http://localhost:3100",
    apiKey: undefined as string | undefined,
    agentId: undefined as string | undefined,
    companyId: undefined as string | undefined,
    mode: "rolling-issue" as const,
    parentIssueId: undefined as string | undefined,
    projectId: undefined as string | undefined,
    goalId: undefined as string | undefined,
    runTimeoutMs: 60_000,
    pollIntervalMs: 1,
    pollIntervalMaxMs: 1,
    ...(settings ?? {}),
  })),
}));

vi.mock("../paperclip-client.js", () => ({
  agentsMe: mockAgentsMe,
  createIssue: mockCreateIssue,
  getIssue: mockGetIssue,
  getIssueComments: mockGetIssueComments,
  getRunEvents: mockGetRunEvents,
  wakeAgent: mockWakeAgent,
  resolvePaperclipConfig: mockResolveConfig,
}));

const baseSessionOpts = {
  cwd: "/repo",
  systemPrompt: "be helpful",
};

function makeAdapter(config: Record<string, unknown> = {}) {
  return new PaperclipRuntimeAdapter(config, {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAgentsMe.mockResolvedValue({
    agentId: "AG-default",
    agentName: "Coder",
    role: "engineer",
    companyId: "CO-default",
    companyName: "Acme",
  });
  const defaultEvents: RunEvent[] = [
    { seq: 1, type: "heartbeat.run.log", payload: { stream: "stdout", chunk: "hello world" } },
    { seq: 2, type: "heartbeat.run.status", payload: { status: "succeeded" } },
  ];
  mockGetRunEvents.mockResolvedValue(defaultEvents);
  mockWakeAgent.mockResolvedValue({ id: "RUN-1", status: "queued" });
  mockCreateIssue.mockResolvedValue({ id: "ISS-1", status: "todo" });
  mockGetIssue.mockResolvedValue({ id: "ISS-1", status: "done" });
  mockGetIssueComments.mockResolvedValue([{ id: "C-1", body: "final answer comment" }]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PaperclipRuntimeAdapter — createSession", () => {
  it("auto-derives agentId/companyId from /agents/me when missing", async () => {
    const adapter = makeAdapter({});
    const result = await adapter.createSession({ ...baseSessionOpts });
    expect(mockAgentsMe).toHaveBeenCalledTimes(1);
    expect(result.session.agentId).toBe("AG-default");
    expect(result.session.companyId).toBe("CO-default");
    expect(result.sessionFile).toBeUndefined();
  });

  it("uses provided agentId/companyId without calling /agents/me", async () => {
    const adapter = makeAdapter({ agentId: "AG-X", companyId: "CO-Y" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    expect(mockAgentsMe).not.toHaveBeenCalled();
    expect(session.agentId).toBe("AG-X");
    expect(session.companyId).toBe("CO-Y");
  });

  it("throws if agents/me fails and identity is missing", async () => {
    mockAgentsMe.mockRejectedValueOnce(new Error("API key rejected"));
    const adapter = makeAdapter({});
    await expect(adapter.createSession({ ...baseSessionOpts })).rejects.toThrow(
      /could not derive agentId\/companyId/,
    );
  });

  it("normalizes invalid mode to rolling-issue", async () => {
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1", mode: "bogus" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    expect(session.mode).toBe("rolling-issue");
  });
});

describe("PaperclipRuntimeAdapter — promptWithFallback (rolling-issue mode)", () => {
  it("creates an issue on first prompt, reuses it on second", async () => {
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    await adapter.promptWithFallback(session, "first prompt");
    await adapter.promptWithFallback(session, "second prompt");
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockWakeAgent).toHaveBeenCalledTimes(2);
    expect(session.issueId).toBe("ISS-1");
  });

  it("forwards stdout chunks to onText", async () => {
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ ...baseSessionOpts, onText });
    await adapter.promptWithFallback(session, "hi");
    expect(onText).toHaveBeenCalledWith("hello world");
  });

  it("idempotency key increments per turn", async () => {
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    await adapter.promptWithFallback(session, "p1");
    await adapter.promptWithFallback(session, "p2");
    const keys = mockWakeAgent.mock.calls.map((c) => (c[3] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toMatch(/:1$/);
    expect(keys[1]).toMatch(/:2$/);
    expect(keys[0].split(":")[0]).toBe(keys[1].split(":")[0]);
  });
});

describe("PaperclipRuntimeAdapter — issue-per-prompt mode", () => {
  it("creates a new issue per prompt", async () => {
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1", mode: "issue-per-prompt" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    await adapter.promptWithFallback(session, "p1");
    await adapter.promptWithFallback(session, "p2");
    expect(mockCreateIssue).toHaveBeenCalledTimes(2);
  });
});

describe("PaperclipRuntimeAdapter — wakeup-only mode", () => {
  it("does not create an issue", async () => {
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1", mode: "wakeup-only" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    await adapter.promptWithFallback(session, "p1");
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockWakeAgent).toHaveBeenCalledTimes(1);
    expect(mockGetIssue).not.toHaveBeenCalled();
  });
});

describe("PaperclipRuntimeAdapter — wakeup soft errors", () => {
  it("status=skipped → onToolEnd isError=true, no polling", async () => {
    mockWakeAgent.mockResolvedValueOnce({ id: "", status: "skipped" });
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const onToolEnd = vi.fn();
    const { session } = await adapter.createSession({ ...baseSessionOpts, onToolEnd });
    await adapter.promptWithFallback(session, "p");
    expect(onToolEnd).toHaveBeenCalledWith(
      "paperclip.run",
      true,
      expect.objectContaining({ runStatus: "skipped" }),
    );
    expect(mockGetRunEvents).not.toHaveBeenCalled();
  });

  it("wakeup throws → onToolEnd isError=true, no polling", async () => {
    mockWakeAgent.mockRejectedValueOnce(new Error("nope"));
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const onToolEnd = vi.fn();
    const { session } = await adapter.createSession({ ...baseSessionOpts, onToolEnd });
    await adapter.promptWithFallback(session, "p");
    expect(onToolEnd).toHaveBeenCalledWith(
      "paperclip.run",
      true,
      expect.objectContaining({ reason: expect.stringContaining("nope") }),
    );
    expect(mockGetRunEvents).not.toHaveBeenCalled();
  });
});

describe("PaperclipRuntimeAdapter — terminal statuses", () => {
  it("succeeded → onToolEnd isError=false", async () => {
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const onToolEnd = vi.fn();
    const { session } = await adapter.createSession({ ...baseSessionOpts, onToolEnd });
    await adapter.promptWithFallback(session, "p");
    expect(onToolEnd).toHaveBeenCalledWith(
      "paperclip.run",
      false,
      expect.objectContaining({ runStatus: "succeeded" }),
    );
  });

  it("failed → onToolEnd isError=true", async () => {
    mockGetRunEvents.mockResolvedValueOnce([
      { seq: 1, type: "heartbeat.run.status", payload: { status: "failed" } },
    ]);
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const onToolEnd = vi.fn();
    const { session } = await adapter.createSession({ ...baseSessionOpts, onToolEnd });
    await adapter.promptWithFallback(session, "p");
    expect(onToolEnd).toHaveBeenCalledWith(
      "paperclip.run",
      true,
      expect.objectContaining({ runStatus: "failed" }),
    );
  });

  it("local timeout → exits with timedOutLocally=true, no throw", async () => {
    mockGetRunEvents.mockResolvedValue([
      { seq: 1, type: "heartbeat.run.status", payload: { status: "running" } },
    ]);
    const adapter = makeAdapter({
      agentId: "AG-1",
      companyId: "CO-1",
      runTimeoutMs: 5,
      pollIntervalMs: 1,
      pollIntervalMaxMs: 1,
    });
    const onToolEnd = vi.fn();
    const { session } = await adapter.createSession({ ...baseSessionOpts, onToolEnd });
    await adapter.promptWithFallback(session, "p");
    expect(onToolEnd).toHaveBeenCalledWith(
      "paperclip.run",
      true,
      expect.objectContaining({ timedOutLocally: true }),
    );
  });
});

describe("PaperclipRuntimeAdapter — comment fallback", () => {
  it("uses latest comment as text when no streamed stdout", async () => {
    mockGetRunEvents.mockResolvedValueOnce([
      { seq: 1, type: "heartbeat.run.status", payload: { status: "succeeded" } },
    ]);
    mockGetIssueComments.mockResolvedValueOnce([
      { id: "C-old", body: "older" },
      { id: "C-latest", body: "latest answer" },
    ]);
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const onText = vi.fn();
    const { session } = await adapter.createSession({ ...baseSessionOpts, onText });
    await adapter.promptWithFallback(session, "p");
    expect(onText).toHaveBeenCalledWith("latest answer");
  });
});

describe("PaperclipRuntimeAdapter — describeModel/dispose", () => {
  it("describeModel returns paperclip/<agentId>", async () => {
    const adapter = makeAdapter({ agentId: "AG-XYZ", companyId: "CO-1" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    expect(adapter.describeModel(session)).toBe("paperclip/AG-XYZ");
  });

  it("dispose is a no-op", async () => {
    const adapter = makeAdapter({ agentId: "AG-1", companyId: "CO-1" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    await expect(adapter.dispose!(session)).resolves.toBeUndefined();
  });
});
