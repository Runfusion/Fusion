import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { OpenClawRuntimeAdapter } from "../runtime-adapter.js";

const {
  mockResolveCliConfig,
  mockCreateCliSession,
  mockPromptCli,
  mockDescribeCliModel,
  mockConfigureOpenClawMcpServer,
} = vi.hoisted(() => ({
  mockResolveCliConfig: vi.fn(),
  mockCreateCliSession: vi.fn(),
  mockPromptCli: vi.fn(),
  mockDescribeCliModel: vi.fn(),
  mockConfigureOpenClawMcpServer: vi.fn(),
}));

vi.mock("../pi-module.js", () => ({
  resolveCliConfig: mockResolveCliConfig,
  createCliSession: mockCreateCliSession,
  promptCli: mockPromptCli,
  describeCliModel: mockDescribeCliModel,
  configureOpenClawMcpServer: mockConfigureOpenClawMcpServer,
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
  mockConfigureOpenClawMcpServer.mockResolvedValue(undefined);
});

describe("OpenClawRuntimeAdapter — identity", () => {
  it("has stable id/name", () => {
    const adapter = new OpenClawRuntimeAdapter();
    expect(adapter.id).toBe("openclaw");
    expect(adapter.name).toBe("OpenClaw Runtime");
  });

  it("uses the local pi-module seam and does not import @fusion/engine", async () => {
    const source = await readFile(new URL("../runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./pi-module.js"');
    expect(source).not.toContain("@fusion/engine");
  });
});

describe("OpenClawRuntimeAdapter — createSession", () => {
  it("configures MCP bridge when custom tools are present", async () => {
    const adapter = new OpenClawRuntimeAdapter({ agentId: "ops" });
    await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "You are helpful",
      tools: [
        { name: "read", description: "builtin", parameters: { type: "object" } },
        { name: "fn_task_list", description: "list", parameters: { type: "object", properties: {} } },
      ],
    });

    expect(mockConfigureOpenClawMcpServer).toHaveBeenCalledOnce();
    expect(mockCreateCliSession).toHaveBeenCalledWith(
      expect.objectContaining({ mcpProfile: expect.stringContaining("fusion-") }),
    );
  });

  it("configures MCP bridge when tools arrive through customTools", async () => {
    const adapter = new OpenClawRuntimeAdapter({ agentId: "ops" });
    await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "You are helpful",
      customTools: [{ name: "fn_task_show", description: "custom", parameters: { type: "object" } }],
    });

    expect(mockConfigureOpenClawMcpServer).toHaveBeenCalledOnce();
  });

  it("does not configure MCP bridge when only built-in tools are provided", async () => {
    const adapter = new OpenClawRuntimeAdapter({ agentId: "ops" });
    await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "You are helpful",
      tools: [{ name: "read", description: "builtin", parameters: { type: "object" } }],
    });

    expect(mockConfigureOpenClawMcpServer).not.toHaveBeenCalled();
    expect(mockCreateCliSession).toHaveBeenCalledWith(
      expect.objectContaining({ mcpProfile: undefined }),
    );
  });

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
