/**
 * RUFU-144 — output-budget-exhausted marker on the dashboard chat send loop.
 *
 * When a turn ends with pi-ai `stopReason: "length"` and ZERO visible content — the model
 * spent its entire maxTokens budget on thinking and was truncated before emitting any
 * output tokens — `ChatManager.sendMessage` must persist `metadata.budgetExhausted = true`
 * on the (empty) assistant message so the shared `StandardChatMessageItem` renders an
 * explicit inline notice in place of the dangling empty bubble (production repro:
 * chat-b9a8c547, qwen38-27b-sg, maxTokens 4096). The marker is NEVER set for:
 * - a "length" turn that DID produce content (the answer wins),
 * - an empty "stop" turn (a legitimate empty answer), or
 * - a final assistant message with no stopReason (plugin CLI runtimes omit it).
 *
 * Spec cases (PROMPT.md Step 4 / Symptom Verification):
 * 1. stopReason "length" + thinking-only content (no text parts), no onText →
 *    addMessage content "" + metadata.budgetExhausted === true; in-flight flag cleared;
 *    no throw
 * 2. stopReason "length" + non-empty text part → no budgetExhausted key
 * 3. stopReason "stop" + empty content → no marker
 * 4. no stopReason (plugin CLI shape) → no marker, no crash
 * 5. stopReason "length" + empty content + streamed onThinking (thinking persisted) →
 *    marker set, thinkingOutput retained
 *
 * Pattern: chat-manager-context-guard.test.ts — mock @fusion/engine
 * createResolvedAgentSession/promptWithFallback (importOriginal spread) + a mock chat
 * store; the REAL ChatManager success path runs against a fake pi-shaped session. No real
 * LLM calls, no network, no port 4040.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockCreateResolvedAgentSession, mockPromptWithFallback, mockChatStore } = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  /*
   * FNXC:ChatOutputBudget 2026-08-21-00:04 (RUFU-144):
   * The declared parameters match chat.ts's real call site (session, prompt, options?) so
   * the mock can drive the fake session's prompt without fighting vitest's parameter
   * inference.
   */
  mockPromptWithFallback: vi.fn(async (_session: unknown, _prompt: unknown, _options?: unknown) => undefined),
  mockChatStore: {
    getSession: vi.fn(),
    createSession: vi.fn(),
    addMessage: vi.fn(async () => ({ id: "msg-persisted" })),
    getMessages: vi.fn(async () => []),
    updateSession: vi.fn(),
    updateMessageMetadata: vi.fn(),
    setInFlightGeneration: vi.fn(),
    setCliSessionFile: vi.fn(),
    recordTokenUsage: vi.fn(),
  },
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    createResolvedAgentSession: mockCreateResolvedAgentSession,
    promptWithFallback: mockPromptWithFallback,
  };
});

import { ChatManager, __setBuildAgentChatPrompt } from "../chat.js";

/*
FNXC:ChatOutputBudget 2026-09-04-04:43:
ThreatCrush CWE-377: ChatManager's projectRootDir must be an exclusive temp directory, not
a predictable /tmp/test path. The suite never writes through this root; afterAll still
removes it.
*/
const TEST_ROOT = mkdtempSync(join(tmpdir(), "fusion-chat-budget-"));
afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/*
FNXC:ChatOutputBudget 2026-08-21-00:04 (RUFU-144):
Fake pi-shaped session for the send-loop seam. The mocked createResolvedAgentSession
captures the streaming callbacks (onText/onThinking) the real engine would hand to the
session, and the mocked promptWithFallback drives the "model run" by invoking the
session's prompt: streamed deltas via the captured callbacks, then the final assistant
row appended to state.messages — exactly what a real pi session does and what the
success path reads back for content, thinking, and stopReason. The session has no
getContextUsage, so RUFU-118's pre-overflow compaction gate fails open (skipped), which
kepts the suite focused on the budget-exhaustion branch.
*/
interface FakeFinalAssistant {
  role: "assistant";
  content?: unknown;
  stopReason?: string;
}

function makeFakeSession(options: {
  finalAssistant: FakeFinalAssistant;
  onTextDeltas?: string[];
  onThinkingDeltas?: string[];
}) {
  const session = {
    model: { provider: "test-provider", id: "test-model", contextWindow: 128_000, maxTokens: 4_096 },
    state: { messages: [] as Array<Record<string, unknown>> },
    prompt: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const createSession = vi.fn(async (opts: {
    onText?: (delta: string) => void;
    onThinking?: (delta: string) => void;
  }) => {
    session.prompt = vi.fn(async () => {
      for (const delta of options.onTextDeltas ?? []) opts.onText?.(delta);
      for (const delta of options.onThinkingDeltas ?? []) opts.onThinking?.(delta);
      session.state.messages.push(options.finalAssistant as never);
    });
    return { session, model: { provider: "test-provider", modelId: "test-model" } };
  });
  return { session, createSession };
}

function makeManager(): ChatManager {
  return new ChatManager(mockChatStore as never, TEST_ROOT, undefined as never, undefined, undefined);
}

function assistantAddMessageCall(): { content: string; thinkingOutput?: string; metadata?: Record<string, unknown> } | undefined {
  const call = mockChatStore.addMessage.mock.calls.find((c) => (c[1] as { role?: string } | undefined)?.role === "assistant");
  return call?.[1] as { content: string; thinkingOutput?: string; metadata?: Record<string, unknown> } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChatStore.getSession.mockReturnValue({
    id: "chat-budget",
    projectId: "proj-1",
    title: "budget-exhaustion-test-session",
  });
  mockChatStore.addMessage.mockImplementation(async () => ({ id: "msg-persisted" }));
  mockChatStore.getMessages.mockImplementation(async () => []);
  // Deterministic system prompt — keeps the test off the real instruction/memory readers.
  __setBuildAgentChatPrompt(async ({ basePrompt }: { basePrompt: string }) => basePrompt);
  // The mocked provider call drives the fake session's prompt (deltas + final row).
  mockPromptWithFallback.mockImplementation(async (sessionArg?: { prompt?: () => Promise<void> }) => {
    await sessionArg?.prompt?.();
  });
});

describe("ChatManager.sendMessage — output-budget-exhausted marker", () => {
  it("persists budgetExhausted when the turn ends stopReason length with thinking-only content and no text", async () => {
    // Production repro shape (chat-b9a8c547): the final assistant row carries only
    // thinking parts (no text parts) and stopReason "length"; no onText was emitted.
    const { createSession } = makeFakeSession({
      finalAssistant: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning that consumes the whole output budget" }],
        stopReason: "length",
      },
    });
    mockCreateResolvedAgentSession.mockImplementation(createSession);
    const manager = makeManager();

    await expect(manager.sendMessage("chat-budget", "Hello")).resolves.toBeUndefined();

    const persisted = assistantAddMessageCall();
    expect(persisted).toBeDefined();
    expect(persisted?.content).toBe("");
    expect(persisted?.metadata).toEqual(expect.objectContaining({ budgetExhausted: true }));
    // The turn completed: the in-flight generation flag is cleared (null drops the payload).
    expect(mockChatStore.setInFlightGeneration).toHaveBeenLastCalledWith("chat-budget", null);
  });

  it("does not persist budgetExhausted for a stopReason-length turn that produced content", async () => {
    const { createSession } = makeFakeSession({
      finalAssistant: {
        role: "assistant",
        content: "partial answer before truncation",
        stopReason: "length",
      },
    });
    mockCreateResolvedAgentSession.mockImplementation(createSession);
    const manager = makeManager();

    await expect(manager.sendMessage("chat-budget", "Hello")).resolves.toBeUndefined();

    const persisted = assistantAddMessageCall();
    expect(persisted).toBeDefined();
    // The answer wins: visible content is persisted and nothing is missing to explain.
    expect(persisted?.content).toBe("partial answer before truncation");
    expect(persisted?.metadata?.budgetExhausted).toBeUndefined();
  });

  it("does not persist budgetExhausted for an empty stopReason-stop turn", async () => {
    const { createSession } = makeFakeSession({
      finalAssistant: {
        role: "assistant",
        content: "",
        stopReason: "stop",
      },
    });
    mockCreateResolvedAgentSession.mockImplementation(createSession);
    const manager = makeManager();

    await expect(manager.sendMessage("chat-budget", "Hello")).resolves.toBeUndefined();

    const persisted = assistantAddMessageCall();
    expect(persisted).toBeDefined();
    // A legitimate empty answer (model finished, nothing truncated) stays marker-free.
    expect(persisted?.content).toBe("");
    expect(persisted?.metadata?.budgetExhausted).toBeUndefined();
  });

  /*
  FNXC:ChatOutputBudget 2026-08-21-00:04 (RUFU-144):
  Plugin CLI runtimes (grok/droid/cursor) omit stopReason on state messages entirely; the
  marker must never be inferred from its absence (a legitimate empty answer must stay
  marker-free and the turn must not crash). Mirrors the production shape where only
  pi-shaped runtimes report stopReason.
  */
  it("does not persist budgetExhausted when the final assistant message has no stopReason (plugin CLI shape)", async () => {
    const { createSession } = makeFakeSession({
      finalAssistant: {
        role: "assistant",
        content: "",
      },
    });
    mockCreateResolvedAgentSession.mockImplementation(createSession);
    const manager = makeManager();

    await expect(manager.sendMessage("chat-budget", "Hello")).resolves.toBeUndefined();

    const persisted = assistantAddMessageCall();
    expect(persisted).toBeDefined();
    expect(persisted?.content).toBe("");
    expect(persisted?.metadata?.budgetExhausted).toBeUndefined();
  });

  /*
  FNXC:ChatOutputBudget 2026-08-21-00:04 (RUFU-144):
  When the thinking streamed via onThinking deltas, the persisted assistant message keeps
  the thinking output (so the UI's thinking disclosure stays populated below the notice)
  while the marker explains the empty visible answer.
  */
  it("persists budgetExhausted with retained thinkingOutput when streamed thinking was the only output before the length stop", async () => {
    const { createSession } = makeFakeSession({
      finalAssistant: {
        role: "assistant",
        content: "",
        stopReason: "length",
      },
      onThinkingDeltas: ["reasoning that consumes the whole output budget"],
    });
    mockCreateResolvedAgentSession.mockImplementation(createSession);
    const manager = makeManager();

    await expect(manager.sendMessage("chat-budget", "Hello")).resolves.toBeUndefined();

    const persisted = assistantAddMessageCall();
    expect(persisted).toBeDefined();
    expect(persisted?.content).toBe("");
    expect(persisted?.thinkingOutput).toBe("reasoning that consumes the whole output budget");
    expect(persisted?.metadata).toEqual(expect.objectContaining({ budgetExhausted: true }));
    expect(mockChatStore.setInFlightGeneration).toHaveBeenLastCalledWith("chat-budget", null);
  });
});
