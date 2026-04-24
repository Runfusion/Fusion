import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenClawRuntimeAdapter } from "../runtime-adapter.js";

const { mockCreateFnAgent, mockPromptWithFallback, mockDescribeModel } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockDescribeModel: vi.fn(),
}));

vi.mock("../pi-module.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: mockPromptWithFallback,
  describeModel: mockDescribeModel,
}));

describe("OpenClawRuntimeAdapter", () => {
  let adapter: OpenClawRuntimeAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDescribeModel.mockReturnValue("mock/anthropic-claude");
    adapter = new OpenClawRuntimeAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has stable runtime identity", () => {
    expect(adapter.id).toBe("openclaw");
    expect(adapter.name).toBe("OpenClaw Runtime");
  });

  it("delegates createSession to createFnAgent with mapped options", async () => {
    const mockSession = { dispose: vi.fn() };
    mockCreateFnAgent.mockResolvedValue({ session: mockSession, sessionFile: "/tmp/session.json" });

    const result = await adapter.createSession({
      cwd: "/project",
      systemPrompt: "You are helpful",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: "openai",
      fallbackModelId: "gpt-4o",
      skills: ["bash"],
    });

    expect(mockCreateFnAgent).toHaveBeenCalledWith({
      cwd: "/project",
      systemPrompt: "You are helpful",
      tools: undefined,
      customTools: undefined,
      onText: undefined,
      onThinking: undefined,
      onToolStart: undefined,
      onToolEnd: undefined,
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: "openai",
      fallbackModelId: "gpt-4o",
      defaultThinkingLevel: undefined,
      sessionManager: undefined,
      skillSelection: undefined,
      skills: ["bash"],
    });
    expect(result.session).toBe(mockSession);
    expect(result.sessionFile).toBe("/tmp/session.json");
  });

  it("delegates promptWithFallback to pi seam", async () => {
    const session = { id: "s-1" };
    mockPromptWithFallback.mockResolvedValue(undefined);

    await adapter.promptWithFallback(session as any, "Hello", { images: [] });

    expect(mockPromptWithFallback).toHaveBeenCalledWith(session, "Hello", { images: [] });
  });

  it("delegates describeModel to pi seam", () => {
    const session = { id: "s-2" };
    mockDescribeModel.mockReturnValue("anthropic/claude-sonnet-4-5");

    const result = adapter.describeModel(session as any);

    expect(mockDescribeModel).toHaveBeenCalledWith(session);
    expect(result).toBe("anthropic/claude-sonnet-4-5");
  });

  it("dispose calls session.dispose when present and no-ops otherwise", async () => {
    const disposeMock = vi.fn().mockResolvedValue(undefined);

    await adapter.dispose({ dispose: disposeMock });
    await expect(adapter.dispose({ id: "no-dispose" } as any)).resolves.toBeUndefined();

    expect(disposeMock).toHaveBeenCalledTimes(1);
  });
});
