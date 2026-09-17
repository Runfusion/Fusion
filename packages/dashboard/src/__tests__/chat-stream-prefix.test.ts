/*
FNXC:AssistantTextCapture 2026-09-15-21:32:
FN-431: the duplicated response prefix ("I'll researchI'll research …") was reported first in chat.
These cases drive the REAL engine capture with pi-shaped events (one shared mutable `partial` object,
queued before consumption) into the callbacks ChatManager.sendMessage actually installs, then assert
the live stream, the in-flight checkpoint, and the persisted assistant message all carry the response
exactly once. They must never hand ChatManager a pre-corrected `onText`.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAssistantStreamCapture } from "../../../engine/src/execution/assistant-text-capture.js";
import {
  createAssistantStreamProducer,
  queueReproStream,
  REPRO_PREFIX,
  REPRO_RESPONSE,
  REPRO_SUFFIX,
} from "../../../engine/src/__tests__/fixtures/assistant-stream-events.js";
import {
  ChatManager,
  __setBuildAgentChatPrompt,
  __setCreateFnAgent,
  __resetChatState,
  chatStreamManager,
} from "../chat.js";

const { mockSummarizeTitle, mockEmitWorkflowSseEvent } = vi.hoisted(() => ({
  mockSummarizeTitle: vi.fn(),
  mockEmitWorkflowSseEvent: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  summarizeTitle: mockSummarizeTitle,
  DASHBOARD_USER_ID: "dashboard",
}));

vi.mock("../sse.js", () => ({ emitWorkflowSseEvent: mockEmitWorkflowSseEvent }));

vi.mock("@earendil-works/pi-coding-agent", () => {
  const fakeManager = {
    getSessionFile: () => "/tmp/test/.pi-fake/session-abc.jsonl",
    getLeafId: () => "leaf-fake",
    branch: () => {},
    resetLeaf: () => {},
    appendMessage: () => "entry-fake",
    buildSessionContext: () => ({ messages: [] }),
    createBranchedSession: () => "/tmp/test/.pi-fake/session-branched.jsonl",
  };
  return { SessionManager: { create: vi.fn(() => fakeManager), open: vi.fn(() => fakeManager) } };
});

const mockChatStore = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  addMessage: vi.fn(),
  getMessage: vi.fn(),
  getMessages: vi.fn(),
  updateSession: vi.fn(),
  setCliSessionFile: vi.fn(),
  setInFlightGeneration: vi.fn(),
  getRoomMessages: vi.fn(),
  recordTokenUsage: vi.fn(),
  deleteMessagesFrom: vi.fn(),
  updateMessageMetadata: vi.fn(),
};

const mockAgentStore = {
  init: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
};

function createChatManager(): ChatManager {
  return new ChatManager(mockChatStore as never, "/tmp/test", mockAgentStore as never);
}

/**
 * Lets the debounced (200 ms) + serialized in-flight checkpoint chain run while the turn is still
 * generating, so the persisted recovery snapshot is observed mid-stream and not only at the end.
 */
async function settleCheckpoints(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 260));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Installs an agent whose prompt() replays raw pi events through the real capture. */
function installCapturingAgent(replay: (drain: (event: unknown) => void) => void | Promise<void>): void {
  __setCreateFnAgent(async (options: { onText?: (delta: string) => void; onThinking?: (delta: string) => void; onTextBlockBoundary?: () => void }) => {
    const capture = createAssistantStreamCapture({
      onText: options.onText,
      onThinking: options.onThinking,
      onTextBlockBoundary: options.onTextBlockBoundary,
    });
    return {
      session: {
        prompt: vi.fn().mockImplementation(async () => { await replay(capture.handleAgentEvent); }),
        dispose: vi.fn(),
        state: { messages: [] },
      },
    } as never;
  });
}

function assistantContent(): string | undefined {
  const call = mockChatStore.addMessage.mock.calls.find((entry) => entry[1].role === "assistant");
  return call?.[1].content as string | undefined;
}

describe("chat streaming keeps the assistant response prefix exactly once", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();
    mockChatStore.getSession.mockReturnValue({ id: "chat-001", agentId: "agent-001", status: "active" });
    mockChatStore.addMessage.mockReturnValue({ id: "msg-001", sessionId: "chat-001", role: "assistant", content: "" });
    mockChatStore.getMessages.mockReturnValue([]);
    mockChatStore.getRoomMessages.mockReturnValue([]);
    mockChatStore.setInFlightGeneration.mockResolvedValue(undefined);
    mockAgentStore.init.mockResolvedValue(undefined);
    mockAgentStore.getAgent.mockResolvedValue({ id: "agent-001", name: "Avery", role: "executor", runtimeConfig: {} });
    mockAgentStore.listAgents.mockResolvedValue([]);
    __setBuildAgentChatPrompt(async ({ basePrompt }: { basePrompt: string }) => basePrompt);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams, checkpoints, and persists a shared-snapshot Claude response once", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = chatStreamManager.subscribe("chat-001", (event) => events.push(event as { type: string; data: unknown }));
    installCapturingAgent(async (drain) => {
      const producer = createAssistantStreamProducer();
      const index = queueReproStream(producer);
      producer.drain(drain);
      await settleCheckpoints();
      producer.delta("text", index, REPRO_SUFFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(drain);
      await settleCheckpoints();
    });

    await createChatManager().sendMessage("chat-001", "Plan this");
    unsubscribe();

    const streamed = events.filter((event) => event.type === "text").map((event) => String(event.data)).join("");
    expect(streamed).toBe(REPRO_RESPONSE);
    expect(streamed).not.toBe(REPRO_PREFIX + REPRO_RESPONSE);
    expect(assistantContent()).toBe(REPRO_RESPONSE);

    const checkpoints = mockChatStore.setInFlightGeneration.mock.calls
      .map((call) => (call[1] as { streamingText?: string } | null)?.streamingText ?? "")
      .filter(Boolean);
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) expect(REPRO_RESPONSE.startsWith(checkpoint)).toBe(true);
  });

  it("keeps every block of a multi-block turn without repeating its opening words", async () => {
    installCapturingAgent((drain) => {
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const first = producer.startBlock("text");
      producer.delta("text", first, REPRO_PREFIX);
      producer.drain(drain);
      producer.delta("text", first, REPRO_SUFFIX);
      producer.endBlock("text", first);
      const second = producer.startBlock("text");
      producer.delta("text", second, "Now the summary.");
      producer.endBlock("text", second);
      producer.messageEnd();
      producer.drain(drain);
    });

    await createChatManager().sendMessage("chat-001", "Plan this");

    const content = assistantContent() ?? "";
    expect(content).toContain(REPRO_RESPONSE);
    expect(content).toContain("Now the summary.");
    expect(content.startsWith(REPRO_PREFIX + REPRO_PREFIX)).toBe(false);
    expect(content.replace(/\s+/g, " ")).toBe(`${REPRO_RESPONSE} Now the summary.`);
  });

  it("preserves an intentionally repeated opening as written by the model", async () => {
    installCapturingAgent((drain) => {
      const producer = createAssistantStreamProducer();
      producer.messageStart();
      const index = producer.startBlock("text");
      producer.delta("text", index, REPRO_PREFIX);
      producer.delta("text", index, REPRO_PREFIX);
      producer.endBlock("text", index);
      producer.messageEnd();
      producer.drain(drain);
    });

    await createChatManager().sendMessage("chat-001", "Repeat yourself");

    expect(assistantContent()).toBe(REPRO_PREFIX + REPRO_PREFIX);
  });
});
