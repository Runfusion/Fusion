import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStreamSession,
  describeStreamModel,
  resolveModelConfig,
  streamPrompt,
} from "../pi-module.js";

const { mockGetModel, mockStreamSimple } = vi.hoisted(() => ({
  mockGetModel: vi.fn(),
  mockStreamSimple: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: mockGetModel,
  streamSimple: mockStreamSimple,
}));

function createFakeStream(events: unknown[], finalMessage: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    result: vi.fn().mockResolvedValue(finalMessage),
  };
}

describe("hermes pi-ai stream client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.HERMES_PROVIDER;
    delete process.env.HERMES_MODEL_ID;
    delete process.env.HERMES_API_KEY;
    delete process.env.HERMES_THINKING_LEVEL;

    mockGetModel.mockReturnValue({ provider: "anthropic", id: "claude-sonnet-4-5" });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolveModelConfig prefers settings over env and env over defaults", () => {
    process.env.HERMES_PROVIDER = "openai";
    process.env.HERMES_MODEL_ID = "gpt-5";
    process.env.HERMES_API_KEY = "env-key";
    process.env.HERMES_THINKING_LEVEL = "medium";

    expect(resolveModelConfig()).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      apiKey: "env-key",
      thinkingLevel: "medium",
    });

    expect(
      resolveModelConfig({ provider: "anthropic", modelId: "claude", apiKey: "plugin-key", thinkingLevel: "high" }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude",
      apiKey: "plugin-key",
      thinkingLevel: "high",
    });

    delete process.env.HERMES_PROVIDER;
    delete process.env.HERMES_MODEL_ID;
    delete process.env.HERMES_API_KEY;
    delete process.env.HERMES_THINKING_LEVEL;

    expect(resolveModelConfig()).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      apiKey: undefined,
      thinkingLevel: undefined,
    });
  });

  it("createStreamSession resolves model and initializes session state", () => {
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const session = createStreamSession({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      apiKey: "key",
      thinkingLevel: "high",
      systemPrompt: "You are Hermes",
      callbacks: { onText, onThinking, onToolStart, onToolEnd },
    });

    expect(mockGetModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5");
    expect(session.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(session.systemPrompt).toBe("You are Hermes");
    expect(session.messages).toEqual([]);
    expect(session.apiKey).toBe("key");
    expect(session.thinkingLevel).toBe("high");
    expect(session.callbacks).toEqual({ onText, onThinking, onToolStart, onToolEnd });
    expect(session.lastModelDescription).toBe("anthropic/claude-sonnet-4-5");
    expect(session.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    const second = createStreamSession({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      systemPrompt: "You are Hermes",
    });
    expect(second.sessionId).not.toBe(session.sessionId);
  });

  it("streamPrompt streams deltas, handles tool calls, stores usage, and appends assistant text only", async () => {
    const onText = vi.fn();
    const onThinking = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const session = createStreamSession({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      apiKey: "api-key",
      thinkingLevel: "medium",
      systemPrompt: "system",
      callbacks: { onText, onThinking, onToolStart, onToolEnd },
    });
    session.messages.push({ role: "user", content: "hello" });

    const doneMessage = {
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "internal" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
        { type: "text", text: " world" },
      ],
      usage: { input: 1, output: 2 },
    };

    mockStreamSimple.mockReturnValue(
      createFakeStream(
        [
          { type: "text_delta", delta: "Hello" },
          { type: "thinking_delta", delta: "thinking" },
          { type: "toolcall_end", toolCall: { name: "bash", arguments: { cmd: "ls" } } },
          { type: "text_delta", delta: " world" },
          { type: "done", message: doneMessage },
        ],
        doneMessage,
      ),
    );

    await streamPrompt(session, { role: "user", content: "ignored" } as any);

    expect(mockStreamSimple).toHaveBeenCalledWith(
      session.model,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        sessionId: session.sessionId,
        apiKey: "api-key",
        reasoning: "medium",
      },
    );

    expect(onText).toHaveBeenNthCalledWith(1, "Hello");
    expect(onText).toHaveBeenNthCalledWith(2, " world");
    expect(onThinking).toHaveBeenCalledWith("thinking");
    expect(onToolStart).toHaveBeenCalledWith("bash", { cmd: "ls" });
    expect(onToolEnd).toHaveBeenCalledWith("bash", false, { cmd: "ls" });
    expect(session.usage).toEqual({ input: 1, output: 2 });
    expect(session.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello world" },
    ]);
    expect(describeStreamModel(session)).toBe("anthropic/claude-sonnet-4-5");
  });

  it("streamPrompt omits optional apiKey/reasoning when unset", async () => {
    const session = createStreamSession({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      systemPrompt: "system",
    });
    session.messages.push({ role: "user", content: "hello" });

    const doneMessage = { content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1 } };
    mockStreamSimple.mockReturnValue(createFakeStream([{ type: "done", message: doneMessage }], doneMessage));

    await streamPrompt(session, { role: "user", content: "ignored" } as any);

    expect(mockStreamSimple).toHaveBeenCalledWith(
      session.model,
      { systemPrompt: "system", messages: [{ role: "user", content: "hello" }] },
      { sessionId: session.sessionId },
    );
  });

  it("streamPrompt throws on error event", async () => {
    const session = createStreamSession({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      systemPrompt: "system",
    });

    const errorMessage = {
      type: "error",
      error: {
        errorMessage: "boom",
      },
    };
    mockStreamSimple.mockReturnValue(createFakeStream([errorMessage], { content: [], usage: {} }));

    await expect(streamPrompt(session, { role: "user", content: "ignored" } as any)).rejects.toThrow("boom");
    expect(session.messages).toEqual([]);
  });
});
