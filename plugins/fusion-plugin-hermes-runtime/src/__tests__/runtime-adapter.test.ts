import { describe, it, expect, vi, beforeEach } from "vitest";
import { HermesRuntimeAdapter } from "../runtime-adapter.js";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("../cli-spawn.js", async () => {
  const actual = await vi.importActual<typeof import("../cli-spawn.js")>(
    "../cli-spawn.js",
  );
  return {
    ...actual,
    invokeHermesCli: mockInvoke,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue({
    body: "hello from hermes",
    sessionId: "20260427_120000_abc123",
  });
});

describe("HermesRuntimeAdapter — identity", () => {
  it("has stable id/name", () => {
    const adapter = new HermesRuntimeAdapter({});
    expect(adapter.id).toBe("hermes");
    expect(adapter.name).toBe("Hermes Runtime");
  });
});

describe("HermesRuntimeAdapter — createSession", () => {
  it("returns a session with empty sessionId and undefined sessionFile", async () => {
    const adapter = new HermesRuntimeAdapter({});
    const onText = vi.fn();
    const result = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "be helpful",
      onText,
    });
    expect(result.sessionFile).toBeUndefined();
    expect(result.session.sessionId).toBe("");
    expect(result.session.systemPrompt).toBe("be helpful");
    expect(result.session.callbacks.onText).toBe(onText);
  });
});

describe("HermesRuntimeAdapter — promptWithFallback", () => {
  it("invokes hermes CLI with no resume on first call", async () => {
    const adapter = new HermesRuntimeAdapter({ model: "claude-sonnet-4-5" });
    const onText = vi.fn();
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
      onText,
    });

    await adapter.promptWithFallback(session, "first prompt");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [prompt, settings, resumeId] = mockInvoke.mock.calls[0];
    expect(prompt).toBe("first prompt");
    expect(settings.model).toBe("claude-sonnet-4-5");
    expect(resumeId).toBeUndefined();
    expect(onText).toHaveBeenCalledWith("hello from hermes");
    // Session id is captured for next call
    expect(session.sessionId).toBe("20260427_120000_abc123");
  });

  it("passes captured session id as --resume on subsequent calls", async () => {
    const adapter = new HermesRuntimeAdapter({});
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    await adapter.promptWithFallback(session, "p1");
    await adapter.promptWithFallback(session, "p2");

    const [, , resume2] = mockInvoke.mock.calls[1];
    expect(resume2).toBe("20260427_120000_abc123");
  });

  it("propagates CLI errors", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("hermes: missing session_id"));
    const adapter = new HermesRuntimeAdapter({});
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    await expect(adapter.promptWithFallback(session, "p")).rejects.toThrow(
      /missing session_id/,
    );
  });

  it("does NOT call onText when body is empty", async () => {
    mockInvoke.mockResolvedValueOnce({
      body: "",
      sessionId: "20260427_120000_def456",
    });
    const adapter = new HermesRuntimeAdapter({});
    const onText = vi.fn();
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
      onText,
    });
    await adapter.promptWithFallback(session, "p");
    expect(onText).not.toHaveBeenCalled();
  });
});

describe("HermesRuntimeAdapter — describeModel", () => {
  it("returns hermes/<provider>/<model> when both set", async () => {
    const adapter = new HermesRuntimeAdapter({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    expect(adapter.describeModel(session)).toBe(
      "hermes/anthropic/claude-sonnet-4-5",
    );
  });

  it("returns hermes/<model> when only model set", async () => {
    const adapter = new HermesRuntimeAdapter({ model: "MiniMax-M2.7" });
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    expect(adapter.describeModel(session)).toBe("hermes/MiniMax-M2.7");
  });

  it("returns plain 'hermes' when neither set", async () => {
    const adapter = new HermesRuntimeAdapter({});
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    expect(adapter.describeModel(session)).toBe("hermes");
  });
});

describe("HermesRuntimeAdapter — dispose", () => {
  it("is a no-op", async () => {
    const adapter = new HermesRuntimeAdapter({});
    const { session } = await adapter.createSession({
      cwd: "/repo",
      systemPrompt: "sys",
    });
    await expect(adapter.dispose!(session)).resolves.toBeUndefined();
  });
});
