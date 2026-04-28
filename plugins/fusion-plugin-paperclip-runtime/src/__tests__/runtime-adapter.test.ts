import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipRuntimeAdapter } from "../runtime-adapter.js";
import type { RunEvent } from "../paperclip-client.js";

const {
  mockAgentsMe,
  mockAgentsMeViaCli,
  mockCreateIssue,
  mockCreateIssueViaCli,
  mockDiscoverPaperclipCliConfig,
  mockGetIssue,
  mockGetIssueViaCli,
  mockGetIssueComments,
  mockGetRunEvents,
  mockWakeAgent,
  mockResolveConfig,
} = vi.hoisted(() => ({
  mockAgentsMe: vi.fn(),
  mockAgentsMeViaCli: vi.fn(),
  mockCreateIssue: vi.fn(),
  mockCreateIssueViaCli: vi.fn(),
  mockDiscoverPaperclipCliConfig: vi.fn(),
  mockGetIssue: vi.fn(),
  mockGetIssueViaCli: vi.fn(),
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
  agentsMeViaCli: mockAgentsMeViaCli,
  createIssue: mockCreateIssue,
  createIssueViaCli: mockCreateIssueViaCli,
  discoverPaperclipCliConfig: mockDiscoverPaperclipCliConfig,
  getIssue: mockGetIssue,
  getIssueViaCli: mockGetIssueViaCli,
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

describe("PaperclipRuntimeAdapter — Local CLI transport", () => {
  beforeEach(() => {
    mockDiscoverPaperclipCliConfig.mockResolvedValue({
      ok: true,
      apiUrl: "http://127.0.0.1:3100",
      apiKey: "cli-discovered-key",
      configPath: "/cfg.json",
      deploymentMode: "local_trusted",
    });
    mockCreateIssueViaCli.mockResolvedValue({ id: "ISS-CLI", status: "todo" });
    mockGetIssueViaCli.mockResolvedValue({ id: "ISS-CLI", status: "done" });
    mockAgentsMeViaCli.mockResolvedValue({
      agentId: "AG-cli",
      agentName: "cli-bot",
      role: "engineer",
      companyId: "CO-cli",
      companyName: "Acme",
    });
  });

  it("createSession runs CLI discovery and stores transport on the session", async () => {
    const adapter = makeAdapter({
      transport: "cli",
      cliBinaryPath: "/opt/bin/paperclipai",
      cliConfigPath: "/cfg.json",
      agentId: "AG-1",
      companyId: "CO-1",
    });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    expect(mockDiscoverPaperclipCliConfig).toHaveBeenCalledWith({
      configPath: "/cfg.json",
    });
    expect(session.transport).toBe("cli");
    expect(session.cliBinaryPath).toBe("/opt/bin/paperclipai");
    expect(session.cliConfigPath).toBe("/cfg.json");
    // Discovered apiKey is plumbed through to the session for HTTP-only fallbacks.
    expect(session.apiKey).toBe("cli-discovered-key");
  });

  it("derives companyId via agentsMeViaCli when missing in CLI mode", async () => {
    const adapter = makeAdapter({ transport: "cli", agentId: "AG-cli" });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    expect(mockAgentsMe).not.toHaveBeenCalled();
    expect(mockAgentsMeViaCli).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "AG-cli" }),
    );
    expect(session.companyId).toBe("CO-cli");
  });

  it("throws a clear error when agentId is missing in CLI mode", async () => {
    const adapter = makeAdapter({ transport: "cli" });
    await expect(adapter.createSession({ ...baseSessionOpts })).rejects.toThrow(
      /agentId is required in Local CLI mode/i,
    );
    expect(mockAgentsMe).not.toHaveBeenCalled();
  });

  it("createIssue and getIssue are routed through the CLI variants on prompt", async () => {
    const adapter = makeAdapter({
      transport: "cli",
      agentId: "AG-1",
      companyId: "CO-1",
    });
    const { session } = await adapter.createSession({ ...baseSessionOpts });
    await adapter.promptWithFallback(session, "do thing");
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockCreateIssueViaCli).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "CO-1",
        body: expect.objectContaining({
          title: expect.any(String),
          assigneeAgentId: "AG-1",
          status: "todo",
        }),
      }),
    );
    expect(mockGetIssueViaCli).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: "ISS-CLI" }),
    );
  });

  it("aborts createSession when CLI discovery fails", async () => {
    mockDiscoverPaperclipCliConfig.mockResolvedValueOnce({
      ok: false,
      reason: "config not found",
    });
    const adapter = makeAdapter({
      transport: "cli",
      agentId: "AG-1",
      companyId: "CO-1",
    });
    await expect(adapter.createSession({ ...baseSessionOpts })).rejects.toThrow(
      /Paperclip CLI mode failed.*config not found/,
    );
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
