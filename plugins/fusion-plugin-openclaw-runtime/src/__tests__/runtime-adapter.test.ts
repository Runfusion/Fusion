import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenClawRuntimeAdapter } from "../runtime-adapter.js";

const {
  mockResolveCliConfig,
  mockCreateCliSession,
  mockPromptCli,
  mockDescribeCliModel,
} = vi.hoisted(() => ({
  mockResolveCliConfig: vi.fn(),
  mockCreateCliSession: vi.fn(),
  mockPromptCli: vi.fn(),
  mockDescribeCliModel: vi.fn(),
}));

vi.mock("../pi-module.js", () => ({
  resolveCliConfig: mockResolveCliConfig,
  createCliSession: mockCreateCliSession,
  promptCli: mockPromptCli,
  describeCliModel: mockDescribeCliModel,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveCliConfig.mockReturnValue({
    binaryPath: "openclaw",
    agentId: "main",
    model: undefined,
    thinking: "off",
    cliTimeoutSec: 0,
    cliTimeoutMs: 300_000,
    useGateway: false,
  });
  mockCreateCliSession.mockImplementation(({ systemPrompt, agentId, callbacks }) => ({
    sessionId: "session-uuid-1",
    agentId: agentId ?? "main",
    systemPrompt,
    messages: [{ role: "developer", content: systemPrompt }],
    lastModelDescription: `openclaw/${agentId ?? "main"}`,
    callbacks,
  }));
  mockDescribeCliModel.mockReturnValue("openclaw/main");
});

describe("OpenClawRuntimeAdapter — identity", () => {
  it("has stable id/name", () => {
    const adapter = new OpenClawRuntimeAdapter();
    expect(adapter.id).toBe("openclaw");
    expect(adapter.name).toBe("OpenClaw Runtime");
  });
});

describe("OpenClawRuntimeAdapter — createSession", () => {
  it("delegates to createCliSession with systemPrompt + agentId + callbacks", async () => {
    const adapter = new OpenClawRuntimeAdapter({ agentId: "ops" });
    const onText = vi.fn();
    const onThinking = vi.fn();
    const result = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "You are helpful",
      onText,
      onThinking,
    });
    expect(mockCreateCliSession).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "You are helpful",
        agentId: "main", // resolved from defaults in our mock
      }),
    );
    expect(result.sessionFile).toBeUndefined();
    expect(result.session.sessionId).toBe("session-uuid-1");
  });
});

describe("OpenClawRuntimeAdapter — promptWithFallback", () => {
  it("calls promptCli with session + prompt + resolved config", async () => {
    const adapter = new OpenClawRuntimeAdapter();
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    await adapter.promptWithFallback(session, "hi");
    expect(mockPromptCli).toHaveBeenCalledTimes(1);
    const [callSession, callPrompt, callConfig] = mockPromptCli.mock.calls[0];
    expect(callSession).toBe(session);
    expect(callPrompt).toBe("hi");
    expect(callConfig).toMatchObject({ binaryPath: "openclaw", useGateway: false });
  });

  it("forwards override callbacks via the options arg", async () => {
    const adapter = new OpenClawRuntimeAdapter();
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    const onText = vi.fn();
    await adapter.promptWithFallback(session, "p", { onText });
    const overrideCallbacks = mockPromptCli.mock.calls[0][3];
    expect(overrideCallbacks?.onText).toBe(onText);
  });
});

describe("OpenClawRuntimeAdapter — describeModel/dispose", () => {
  it("describeModel delegates to describeCliModel", async () => {
    const adapter = new OpenClawRuntimeAdapter();
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    expect(adapter.describeModel(session)).toBe("openclaw/main");
    expect(mockDescribeCliModel).toHaveBeenCalledWith(session);
  });

  it("dispose is a no-op", async () => {
    const adapter = new OpenClawRuntimeAdapter();
    await expect(adapter.dispose!({} as any)).resolves.toBeUndefined();
  });
});
