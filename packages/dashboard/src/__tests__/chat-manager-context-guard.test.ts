/**
 * RUFU-118 — ChatManager pre-overflow compaction gate: dashboard seam wiring.
 *
 * The deterministic pre-overflow compaction gate (engine
 * `ensureContextWithinCompactionThreshold`) sits on the dashboard chat model seam:
 * `sendMessage` must re-measure the loaded context and compact BEFORE `promptWithFallback`
 * runs, so a context that no longer fits the model window never becomes an over-window
 * provider call (pi's own threshold compaction is blind when the provider omits usage —
 * dsai1, Step 1 root cause).
 *
 * This suite exercises the REAL gate function (engine barrel loaded via importOriginal
 * spread) against fake pi-shaped sessions, overriding only `createResolvedAgentSession`
 * and `promptWithFallback`. No real LLM calls, no network, no port 4040.
 *
 * Spec cases (PROMPT.md Step 3):
 * - below threshold → prompt is sent, no compact
 * - above threshold → compact is called strictly BEFORE the prompt (call order asserted),
 *   then the prompt is sent
 * - still at/above the hard limit after compaction → ChatContextOverflowError surfaces
 *   as a distinct, descriptive persisted+broadcast failure (not "AI processing failed");
 *   the prompt is NOT sent
 * - compaction returns no result (null) → ChatContextOverflowError; the prompt is NOT sent
 * - tokenCap from chat settings is the operator's upper bound on the effective threshold
 * - zero-provider-usage history (dsai1 shape — usage null, chars/4 estimate only) →
 *   compact fires from the estimate (pi's own threshold check is blind there)
 * - non-pi session shape (no getContextUsage) → gate skipped, prompt sent (fail open)
 * - cliExecutorAdapterId branch (CLI-agent chat) → the PTY branch returns before the
 *   model loop, so the gate is never invoked and no prompt is sent
 * - sendRoomMessage seam mirrors the main-seam contract: compact-before-prompt on the
 *   responder session, and compaction failure → no prompt + RoomReplyGenerationError
 *
 * Note on failure persistence: `buildChatFailureInfo` uses `error.message` as the summary
 * (the "Chat context overflow" fallback only applies to empty messages), so the persisted
 * bubble content is the gate's descriptive message; the overflow identity travels in
 * `metadata.failureInfo.code === "CHAT_CONTEXT_OVERFLOW"` and
 * `errorClass === "ChatContextOverflowError"`.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockCreateResolvedAgentSession, mockPromptWithFallback, mockChatStore } = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  /*
  FNXC:ChatContextGuardRoomSeam 2026-08-18-19:29:
  The declared parameters match chat.ts's real call site (session, prompt, options?) so the
  room-seam test can observe the prompt-side reply (the model message the responder
  extracts) without fighting vitest's zero-parameter inference.
  */
  mockPromptWithFallback: vi.fn(async (_session: unknown, _prompt: string, _options?: unknown) => undefined),
  mockChatStore: {
    getSession: vi.fn(),
    createSession: vi.fn(),
    addMessage: vi.fn(async () => ({ id: "msg-persisted" })),
    getMessages: vi.fn(async () => []),
    updateSession: vi.fn(),
    updateMessageMetadata: vi.fn(),
    setInFlightGeneration: vi.fn(),
    setCliSessionFile: vi.fn(),
    getRoomMessages: vi.fn(async () => []),
    recordTokenUsage: vi.fn(),
    /*
    FNXC:ChatContextGuardRoomSeam 2026-08-18-19:29:
    Room-path store methods let the sendRoomMessage seam test run the compaction gate
    without a real store: getRoom/listRoomMembers resolve one member agent and
    addRoomMessage records the persisted user/assistant room messages the test asserts.
    */
    getRoom: vi.fn(),
    listRoomMembers: vi.fn(),
    addRoomMessage: vi.fn(async () => ({ id: "room-msg-persisted", createdAt: "2026-01-01T00:00:00.000Z" })),
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

import { ChatManager, RoomReplyGenerationError, __setBuildAgentChatPrompt, chatStreamManager } from "../chat.js";
import { ChatContextOverflowError } from "@fusion/engine";

/*
FNXC:ChatContextGuardRoomSeam 2026-09-04-05:38:
ThreatCrush CWE-377: ChatManager's projectRootDir must be an exclusive temp directory, not
a predictable OS temporary-directory path. The suite never writes through this root; afterAll
still removes it.
*/
const TEST_ROOT = mkdtempSync(join(tmpdir(), "fusion-chat-guard-"));
afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/*
FNXC:ChatContextGuard 2026-08-18-18:06:
Fake pi-shaped session for the gate seam. `usageTokens` models provider-reported usage
(null models the dsai1 zero/omitted-usage case where the gate falls back to the
chars/4 estimate over loaded messages). `compact` models pi's post-compaction shape:
provider usage resets to null and the message list collapses to a compactionSummary.
The summary message MUST carry a `summary` field — pi's estimateTokens reads
`message.summary.length` for compactionSummary roles (not `content`).
*/
interface FakeSessionOptions {
  contextWindow: number;
  maxTokens: number;
  usageTokens: number | null;
  /** "summarize" (default) collapses the transcript; "null" models a failed/no-op compact. */
  compactBehavior?: "summarize" | "null";
  /** Tokens the post-compaction context measures to (via chars/4 over the summary). */
  compactAfterTokens?: number;
  /** Hook invoked when the gate drives compact() — records call order for assertions. */
  onCompact?: () => void;
  /** Loaded history seeded before the gate measures it (the zero-usage estimate source). */
  initialMessages?: Array<{ role: string; content?: string; summary?: string }>;
}

function makeFakeSession(opts: FakeSessionOptions) {
  const usageState = { tokens: opts.usageTokens };
  const compact = vi.fn(async () => {
    opts.onCompact?.();
    if (opts.compactBehavior === "null") return null;
    usageState.tokens = null;
    session.state.messages = [
      { role: "compactionSummary", summary: "x".repeat((opts.compactAfterTokens ?? 0) * 4) },
    ];
    return { summary: "summary", firstKeptEntryId: "1", tokensBefore: 150_000 };
  });
  const session = {
    model: {
      provider: "test-provider",
      id: "test-model",
      contextWindow: opts.contextWindow,
      maxTokens: opts.maxTokens,
    },
    state: { messages: [...(opts.initialMessages ?? [])] as Array<{ role: string; content?: string; summary?: string }> },
    getContextUsage: () => ({
      tokens: usageState.tokens,
      contextWindow: opts.contextWindow,
      percent: null,
    }),
    compact,
    dispose: vi.fn(),
  };
  return { session, compact };
}

/*
FNXC:ChatContextGuardRoomSeam 2026-08-18-19:29:
Optional agentStore parameter so the room-seam tests resolve one ambient responder
(sendRoomMessage builds responders from agentStore agents + room membership).
*/
function makeManager(
  getSettings?: () => Promise<Record<string, unknown> | undefined>,
  agentStore?: unknown,
) {
  return new ChatManager(mockChatStore as never, TEST_ROOT, agentStore as never, undefined, getSettings);
}

function setupSession(overrides: Record<string, unknown> = {}) {
  mockChatStore.getSession.mockReturnValue({
    id: "chat-guard",
    projectId: "proj-1",
    title: "guard-test-session",
    ...overrides,
  });
}

/** Find the persisted overflow failure (assistant message carrying the overflow code). */
function findOverflowFailureCall(): [string, { content?: string; metadata?: { failureInfo?: { code?: string; errorClass?: string } } }] | undefined {
  return mockChatStore.addMessage.mock.calls.find(
    (call) =>
      call[1]?.role === "assistant" &&
      (call[1]?.metadata as { failureInfo?: { code?: string } } | undefined)?.failureInfo?.code === "CHAT_CONTEXT_OVERFLOW",
  ) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChatStore.addMessage.mockImplementation(async () => ({ id: "msg-persisted" }));
  mockChatStore.getMessages.mockImplementation(async () => []);
  mockChatStore.getRoomMessages.mockImplementation(async () => []);
  mockPromptWithFallback.mockImplementation(async () => undefined);
});

describe("ChatManager.sendMessage — pre-overflow compaction gate (dashboard seam)", () => {
  it("sends the prompt without compacting when the loaded context is below the threshold", async () => {
    // 128K window / 16K maxTokens → default threshold 102,400; 50,000 loaded is below it.
    setupSession();
    const { session, compact } = makeFakeSession({
      contextWindow: 128_000,
      maxTokens: 16_384,
      usageTokens: 50_000,
    });
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    const manager = makeManager();

    await manager.sendMessage("chat-guard", "hello world");

    expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
  });

  it("compacts once, then sends the prompt, when the loaded context is above the threshold", async () => {
    // 150,000 loaded > 102,400 default threshold → compact; post-compaction 20,000 <
    // 111,616 hard limit → proceed.
    const order: string[] = [];
    setupSession();
    const { session, compact } = makeFakeSession({
      contextWindow: 128_000,
      maxTokens: 16_384,
      usageTokens: 150_000,
      compactAfterTokens: 20_000,
      onCompact: () => {
        order.push("compact");
      },
    });
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    mockPromptWithFallback.mockImplementation(async () => {
      order.push("prompt");
      return undefined;
    });
    const manager = makeManager();

    await manager.sendMessage("chat-guard", "hello world");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
    // The gate must compact strictly BEFORE the provider call — the whole point of a
    // pre-overflow gate (an over-window prompt never leaves the process).
    expect(order).toEqual(["compact", "prompt"]);
  });

  it("surfaces a distinct overflow failure and skips the prompt when the context is still at/above the hard limit after compaction", async () => {
    // 150,000 loaded → compact; post-compaction 120,000 ≥ 111,616 hard limit → throw.
    setupSession();
    const { session, compact } = makeFakeSession({
      contextWindow: 128_000,
      maxTokens: 16_384,
      usageTokens: 150_000,
      compactAfterTokens: 120_000,
    });
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    const manager = makeManager();

    await manager.sendMessage("chat-guard", "hello world");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(mockPromptWithFallback).not.toHaveBeenCalled();
    // Distinct, descriptive failure (not the generic "AI processing failed") with the
    // overflow code and class, so the client can distinguish an overflow from a provider
    // failure.
    const failureCall = findOverflowFailureCall();
    expect(failureCall).toBeDefined();
    const persisted = failureCall?.[1];
    expect(persisted?.content).toContain("prompt was not sent");
    expect(persisted?.content).not.toBe("AI processing failed");
    expect(persisted?.metadata?.failureInfo?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(persisted?.metadata?.failureInfo?.errorClass).toBe("ChatContextOverflowError");
  });

  it("surfaces a distinct overflow failure and skips the prompt when compaction returns no result", async () => {
    setupSession();
    const { session, compact } = makeFakeSession({
      contextWindow: 128_000,
      maxTokens: 16_384,
      usageTokens: 150_000,
      compactBehavior: "null",
    });
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    const manager = makeManager();
    const broadcastSpy = vi.spyOn(chatStreamManager, "broadcast").mockReturnValue(0);

    await manager.sendMessage("chat-guard", "hello world");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(mockPromptWithFallback).not.toHaveBeenCalled();
    // The operator-visible error event is broadcast to the session's subscribers in
    // addition to the persisted failure message (spec: fail-loud, chat-visible).
    expect(broadcastSpy).toHaveBeenCalledWith(
      "chat-guard",
      expect.objectContaining({ type: "error" }),
      expect.objectContaining({ generationId: expect.any(Number) }),
    );
    broadcastSpy.mockRestore();
    const failureCall = findOverflowFailureCall();
    expect(failureCall).toBeDefined();
    const persisted = failureCall?.[1];
    expect(persisted?.content).toContain("prompt was not sent");
    expect(persisted?.metadata?.failureInfo?.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(persisted?.metadata?.failureInfo?.errorClass).toBe("ChatContextOverflowError");
  });

  it("treats the settings tokenCap as the upper bound of the effective threshold", async () => {
    // tokenCap 50,000 < default threshold 102,400 → 60,000 loaded is above the capped
    // threshold and must compact even though it would pass the uncapped default.
    setupSession();
    const { session, compact } = makeFakeSession({
      contextWindow: 128_000,
      maxTokens: 16_384,
      usageTokens: 60_000,
      compactAfterTokens: 20_000,
    });
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    const manager = makeManager(async () => ({ tokenCap: 50_000 }));

    await manager.sendMessage("chat-guard", "hello world");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
  });

  it("compacts from the chars/4 estimate when the provider reports no usage (dsai1 zero-usage shape)", async () => {
    // The dsai1/deepseek-v4 repro shape: openai-completions streams omit usage, so the
    // usage reader reports null and pi's own threshold check refuses ("No usage data at
    // all"). The gate must still fire on the chars/4 estimate over the loaded history:
    // 600,000 chars estimate to 150,000 tokens >= 102,400 default threshold.
    setupSession();
    const { session, compact } = makeFakeSession({
      contextWindow: 128_000,
      maxTokens: 16_384,
      usageTokens: null,
      initialMessages: [{ role: "user", content: "a".repeat(600_000) }],
      compactAfterTokens: 20_000,
    });
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    const manager = makeManager();

    await manager.sendMessage("chat-guard", "hello world");

    expect(compact).toHaveBeenCalledTimes(1);
    expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
  });

  it("lets the prompt through unchanged when the session has no context usage reader (non-pi runtime)", async () => {
    // Non-pi sessions (plugin CLI runtimes) lack getContextUsage → gate skips.
    setupSession();
    const session = {
      model: { provider: "test-provider", id: "test-model", contextWindow: 128_000, maxTokens: 16_384 },
      dispose: vi.fn(),
    };
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    const manager = makeManager();

    await manager.sendMessage("chat-guard", "hello world");

    expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
  });

  it("never invokes the gate for CLI-agent chat (cliExecutorAdapterId branches to the PTY runner)", async () => {
    // The cliExecutorAdapterId branch in sendMessage returns BEFORE the model loop, so
    // the pre-overflow gate (and the whole loop) must never run for those sends: the
    // PTY process owns that context and Fusion cannot compact it (documented
    // limitation — the guard requires an in-process pi AgentSession).
    setupSession({ cliExecutorAdapterId: "adapter-1" });
    const ensureSession = vi.fn(async (): Promise<string> => "pty-session-1");
    const send = vi.fn(async (): Promise<"sent" | "queued"> => "sent");
    const manager = makeManager();
    manager.setCliChatRunner({ ensureSession, send }, "proj-1");

    await manager.sendMessage("chat-guard", "hello world");

    expect(ensureSession).toHaveBeenCalledWith("chat-guard", { projectId: "proj-1" });
    expect(send).toHaveBeenCalledWith("chat-guard", "hello world");
    // The model loop never ran: no session creation, no gate, no prompt.
    expect(mockCreateResolvedAgentSession).not.toHaveBeenCalled();
    expect(mockPromptWithFallback).not.toHaveBeenCalled();
  });
});

/*
FNXC:ChatContextGuardRoomSeam 2026-08-18-19:29:
RUFU-118 requires the SAME guarantee on the room responder path (the pi-session path
sendRoomMessage runs on): compact strictly before the responder prompt, and a compaction
failure surfaces as the room-level RoomReplyGenerationError with NO prompt call —
mirroring the main-seam contract above. The system prompt stays deterministic via
__setBuildAgentChatPrompt so the real instruction/memory readers are not exercised
(covered by chat-manager.test.ts).
*/
describe("ChatManager.sendRoomMessage — pre-overflow compaction gate (room seam)", () => {
  const roomAgent = { id: "agent-1", name: "Agent One", role: "executor" } as never;
  const fakeAgentStore = {
    init: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => [roomAgent]),
    getAgent: vi.fn(async () => roomAgent),
    getRatingSummary: vi.fn(async () => null),
  } as never;

  function setupRoom(): void {
    mockChatStore.getRoom.mockResolvedValue({ id: "room-1", name: "test-room", projectId: "proj-1" });
    mockChatStore.listRoomMembers.mockResolvedValue([{ agentId: "agent-1" }]);
    mockChatStore.addRoomMessage.mockImplementation(async () => ({ id: "room-msg-1", createdAt: "2026-01-01T00:00:00.000Z" }));
    mockChatStore.getRoomMessages.mockImplementation(async () => []);
    // Deterministic system prompt — keeps the test off the real instruction/memory readers.
    __setBuildAgentChatPrompt(async ({ basePrompt }: { basePrompt: string }) => basePrompt);
  }

  it("compacts the responder context before the prompt and persists the room reply when above the threshold", async () => {
    setupRoom();
    const order: string[] = [];
    const { session, compact } = makeFakeSession({
      contextWindow: 128_000,
      maxTokens: 16_384,
      usageTokens: 150_000,
      compactAfterTokens: 20_000,
      onCompact: () => {
        order.push("compact");
      },
    });
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    mockPromptWithFallback.mockImplementation(async (sessionArg?: unknown) => {
      order.push("prompt");
      // The model reply the responder-reply extraction reads back from state.messages.
      const s = sessionArg as { state?: { messages?: Array<{ role: string; content?: string }> } };
      s?.state?.messages?.push({ role: "assistant", content: "room reply" });
      return undefined;
    });
    const manager = makeManager(undefined, fakeAgentStore);

    const result = await manager.sendRoomMessage("room-1", "what is the status");

    expect(order).toEqual(["compact", "prompt"]);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(result.responders).toEqual(["agent-1"]);
    const assistantCall = mockChatStore.addRoomMessage.mock.calls.find((call) => call[1]?.role === "assistant");
    expect(assistantCall?.[1]?.content).toBe("room reply");
  });

  it("does not prompt and rejects with RoomReplyGenerationError when the responder context cannot be compacted", async () => {
    setupRoom();
    const { session, compact } = makeFakeSession({
      contextWindow: 128_000,
      maxTokens: 16_384,
      usageTokens: 150_000,
      compactBehavior: "null",
    });
    mockCreateResolvedAgentSession.mockResolvedValue({ session, model: { provider: "test-provider", modelId: "test-model" } });
    const manager = makeManager(undefined, fakeAgentStore);

    await expect(manager.sendRoomMessage("room-1", "what is the status")).rejects.toBeInstanceOf(RoomReplyGenerationError);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(mockPromptWithFallback).not.toHaveBeenCalled();
    // No assistant room reply was persisted — the failure is the room-level error.
    const assistantCall = mockChatStore.addRoomMessage.mock.calls.find((call) => call[1]?.role === "assistant");
    expect(assistantCall).toBeUndefined();
  });
});

describe("ChatContextOverflowError", () => {
  it("is non-retryable with code CHAT_CONTEXT_OVERFLOW (engine barrel export)", () => {
    const err = new ChatContextOverflowError("context still exceeds the limit after compaction");
    expect(err.code).toBe("CHAT_CONTEXT_OVERFLOW");
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(Error);
  });
});
