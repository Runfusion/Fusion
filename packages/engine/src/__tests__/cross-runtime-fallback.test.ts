import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveRuntime } = vi.hoisted(() => ({ resolveRuntime: vi.fn() }));
vi.mock("../execution/runtime-resolution.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../execution/runtime-resolution.js")>(),
  resolveRuntime,
}));

import {
  armDeferredCrossRuntimeFallback,
  captureTransferableConversationContext,
  TRANSFERABLE_CONVERSATION_LIMITS,
} from "../agents/cross-runtime-fallback.js";

const primaryError = new Error("rate limit exceeded");

function createSession(prompt = vi.fn(async () => { throw primaryError; })) {
  return {
    promptWithFallback: prompt,
    dispose: vi.fn(),
    state: { messages: [{ role: "user", content: "Earlier user context" }, { role: "assistant", content: [{ type: "text", text: "Earlier answer" }, { type: "thinking", text: "private" }] }] },
  };
}

function arm(session: ReturnType<typeof createSession>, overrides: Record<string, unknown> = {}) {
  armDeferredCrossRuntimeFallback({
    session: session as never,
    sessionPurpose: "executor",
    pluginRunner: {} as never,
    runAuditor: undefined,
    deferred: { providerId: "cursor-cli", runtimeId: "cursor", modelId: "cursor-small", thinkingLevel: undefined },
    createOptions: { cwd: "/tmp", systemPrompt: "system", defaultProvider: "cursor-cli", defaultModelId: "cursor-small" },
    primaryProvider: "openai",
    primaryModelId: "gpt",
    onFallbackModelUsed: undefined,
    taskId: undefined,
    taskTitle: undefined,
    auditEventType: "session:cross-runtime-fallback-engaged",
    preserveConversationContext: true,
    ...overrides,
  });
}

describe("cross-runtime fallback", () => {
  beforeEach(() => resolveRuntime.mockReset());

  it("leaves non-retryable primary errors untouched", async () => {
    const error = new Error("prompt rejected");
    const session = createSession(vi.fn(async () => { throw error; }));
    arm(session);
    await expect((session.promptWithFallback as (prompt: string) => Promise<unknown>)("hello")).rejects.toBe(error);
    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it("swaps once, transfers portable context once, and disposes the replacement", async () => {
    const fallbackPrompt = vi.fn(async () => "swapped");
    const fallbackSession = { dispose: vi.fn() };
    resolveRuntime.mockResolvedValue({ runtimeId: "cursor", runtime: { createSession: vi.fn(async () => ({ session: fallbackSession })), promptWithFallback: fallbackPrompt } });
    const session = createSession();
    arm(session);
    const prompt = session.promptWithFallback as (prompt: string) => Promise<unknown>;
    await expect(prompt("current request")).resolves.toBe("swapped");
    await expect(prompt("later request")).resolves.toBe("swapped");
    expect(resolveRuntime).toHaveBeenCalledTimes(1);
    expect(fallbackPrompt.mock.calls[0]?.[1]).toContain("Transferred prior conversation from openai/gpt");
    expect(fallbackPrompt.mock.calls[0]?.[1]).toContain("Earlier answer");
    expect(fallbackPrompt.mock.calls[0]?.[1]).not.toContain("private");
    expect(fallbackPrompt.mock.calls[1]?.[1]).toBe("later request");
    await session.dispose();
    expect(fallbackSession.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["resolves another runtime", { runtimeId: "pi", runtime: {} }],
    ["cannot create the replacement", { runtimeId: "cursor", runtime: { createSession: vi.fn(async () => { throw new Error("create failed"); }) } }],
  ])("rethrows the original error when it %s", async (_label, resolved) => {
    resolveRuntime.mockResolvedValue(resolved);
    const session = createSession();
    arm(session);
    await expect((session.promptWithFallback as (prompt: string) => Promise<unknown>)("hello")).rejects.toBe(primaryError);
  });

  it("shares one handoff across concurrent primary failures", async () => {
    let releaseCreation!: (value: { session: { dispose: ReturnType<typeof vi.fn> } }) => void;
    const fallbackSession = { dispose: vi.fn() };
    const createFallbackSession = vi.fn(() => new Promise<{ session: typeof fallbackSession }>((resolve) => { releaseCreation = resolve; }));
    const fallbackPrompt = vi.fn(async (_session: unknown, prompt: string) => prompt);
    const observer = vi.fn();
    const database = vi.fn();
    resolveRuntime.mockResolvedValue({ runtimeId: "cursor", runtime: { createSession: createFallbackSession, promptWithFallback: fallbackPrompt } });
    const session = createSession();
    arm(session, { onFallbackModelUsed: observer, runAuditor: { database } });
    const prompt = session.promptWithFallback as (prompt: string) => Promise<unknown>;
    const first = prompt("first");
    const second = prompt("second");
    await vi.waitFor(() => expect(createFallbackSession).toHaveBeenCalledOnce());
    releaseCreation({ session: fallbackSession });
    await Promise.all([first, second]);
    expect(resolveRuntime).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();
    expect(database).toHaveBeenCalledOnce();
    expect(fallbackPrompt).toHaveBeenCalledTimes(2);
    expect(fallbackPrompt.mock.calls.filter((call) => String(call[1]).includes("Transferred prior conversation"))).toHaveLength(1);
  });

  it("retries the primary after a failed handoff and preserves each primary error", async () => {
    const firstPrimaryError = new Error("rate limit first");
    const secondPrimaryError = new Error("rate limit second");
    const primary = vi.fn()
      .mockRejectedValueOnce(firstPrimaryError)
      .mockRejectedValueOnce(secondPrimaryError);
    resolveRuntime
      .mockRejectedValueOnce(new Error("cursor unavailable"))
      .mockResolvedValueOnce({ runtimeId: "cursor", runtime: { createSession: vi.fn(async () => { throw new Error("create failed"); }) } });
    const session = createSession(primary);
    arm(session);
    const prompt = session.promptWithFallback as (prompt: string) => Promise<unknown>;
    await expect(prompt("first")).rejects.toBe(firstPrimaryError);
    await expect(prompt("second")).rejects.toBe(secondPrimaryError);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(resolveRuntime).toHaveBeenCalledTimes(2);
  });

  it("does not let observer or audit failures block the swapped prompt", async () => {
    const fallbackPrompt = vi.fn(async () => "swapped");
    resolveRuntime.mockResolvedValue({ runtimeId: "cursor", runtime: { createSession: vi.fn(async () => ({ session: {} })), promptWithFallback: fallbackPrompt } });
    const session = createSession();
    arm(session, { onFallbackModelUsed: vi.fn(async () => { throw new Error("observer"); }), runAuditor: { database: vi.fn(async () => { throw new Error("audit"); }) } });
    await expect((session.promptWithFallback as (prompt: string) => Promise<unknown>)("hello")).resolves.toBe("swapped");
  });

  it("extracts bounded text-only context across supported message shapes", () => {
    expect(captureTransferableConversationContext({ getMessages: () => [{ role: "assistant", content: [{ type: "tool", text: "ignore" }, { type: "text", text: "keep" }] }] })).toBe("assistant: keep");
    expect(captureTransferableConversationContext({ state: { messages: [] } })).toBeUndefined();
    expect(captureTransferableConversationContext({ messages: [{ role: "user", content: "string content" }] })).toBe("user: string content");
    const oversized = "x".repeat(TRANSFERABLE_CONVERSATION_LIMITS.maxCharsPerTurn + 1);
    expect(captureTransferableConversationContext({ agent: { state: { messages: [{ role: "user", content: oversized }] } } })).toContain("[truncated]");
    const manyTurns = Array.from({ length: 12 }, (_, index) => ({ role: "user", content: `turn-${index}` }));
    const recent = captureTransferableConversationContext({ messages: manyTurns });
    expect(recent).not.toContain("turn-0");
    expect(recent).toContain("turn-11");
    const total = captureTransferableConversationContext({ messages: Array.from({ length: 10 }, () => ({ role: "user", content: "x".repeat(2_000) })) });
    expect(total?.length).toBeLessThanOrEqual(TRANSFERABLE_CONVERSATION_LIMITS.maxCharsTotal);
    expect(total?.split("\n").every((turn) => turn.length <= TRANSFERABLE_CONVERSATION_LIMITS.maxCharsPerTurn)).toBe(true);
  });
});
