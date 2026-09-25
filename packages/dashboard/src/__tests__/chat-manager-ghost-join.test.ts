/*
FNXC:ChatPersistence 2026-09-12-20:55:
RUFU-230 symptom regression for the dashboard persistence side of the chat-stream stutter. The done handler
reconciles the persisted assistant reply between the streamed capture (`accumulatedText`) and the pi
transcript join (`authoritativeText`), preferring whichever is LONGER. That comparison is exactly what let an
interrupted turn's half-typed prefix get saved: a Stop bakes the prefix into the pi session as its own
assistant message, so the transcript join ("Sk\n\nSkúsim — priamo.") is longer than the real streamed reply
("Skúsim — priamo.") and wins, persisting the ghost. The same happens for an errored turn and for a plain
retry ghost whose text is a strict prefix of the next assistant slice. These tests pin the persisted row (the
operator-visible artifact) at the ChatManager.sendMessage seam: aborted/error slices and strict-prefix ghosts
are excluded, while a legitimate multi-part assistant turn still joins with "\n\n".
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ChatManager,
  __setBuildAgentChatPrompt,
  __setCreateResolvedAgentSession,
  __resetChatState,
} from "../chat.js";

const { mockSummarizeTitle } = vi.hoisted(() => ({ mockSummarizeTitle: vi.fn() }));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  summarizeTitle: mockSummarizeTitle,
  DASHBOARD_USER_ID: "dashboard",
}));

vi.mock("../sse.js", () => ({ emitWorkflowSseEvent: vi.fn() }));

// The pi SessionManager is only touched for leaf/bookkeeping on this path; stub the statics so the
// suite never writes into the real ~/.pi session directory.
const fakeSessionManager = {
  getSessionFile: () => "/tmp/rufu-230-ghost/.pi-fake/session.jsonl",
  getLeafId: () => "leaf-fake",
  branch: () => {},
  resetLeaf: () => {},
  appendMessage: () => "entry-fake",
  buildSessionContext: () => ({ messages: [] }),
  createBranchedSession: () => "/tmp/rufu-230-ghost/.pi-fake/session-branched.jsonl",
};
vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    create: () => fakeSessionManager,
    open: () => fakeSessionManager,
  },
}));

type SessionMessage = {
  role: string;
  content?: string | Array<{ type: string; text: string }>;
  stopReason?: string;
};

/** Assistant slice shaped the way a pi transcript records it (content blocks + stopReason). */
function assistant(text: string, stopReason: string): SessionMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

describe("ChatManager.sendMessage — persisted reply excludes interruption ghosts (RUFU-230)", () => {
  const store = {
    getSession: vi.fn(),
    addMessage: vi.fn(),
    getMessage: vi.fn(),
    getMessages: vi.fn(),
    updateSession: vi.fn(),
    setCliSessionFile: vi.fn(),
    setInFlightGeneration: vi.fn(),
    updateMessageMetadata: vi.fn(),
    recordTokenUsage: vi.fn(),
  };
  const agentStore = {
    init: vi.fn(),
    getAgent: vi.fn(),
    listAgents: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetChatState();
    store.getSession.mockReturnValue({ id: "chat-001", agentId: "agent-001", status: "active", title: "Existing" });
    store.addMessage.mockImplementation((_sessionId: string, input: { role: string; content: string }) => ({
      id: `msg-${input.role}`,
      sessionId: "chat-001",
      role: input.role,
      content: input.content,
      createdAt: "2026-09-12T00:00:00.000Z",
    }));
    store.getMessages.mockReturnValue([]);
    store.setInFlightGeneration.mockResolvedValue(undefined);
    agentStore.init.mockResolvedValue(undefined);
    agentStore.getAgent.mockResolvedValue({ id: "agent-001", name: "Avery", role: "executor", runtimeConfig: {} });
    agentStore.listAgents.mockResolvedValue([]);
    __setBuildAgentChatPrompt(async ({ basePrompt }: any) => basePrompt);
  });

  afterEach(() => {
    __resetChatState();
    vi.restoreAllMocks();
  });

  /**
   * Drives one real turn: streams `streamed` through the capture callbacks (what the operator watched
   * render) and exposes `transcript` as the pi session state the done handler reconciles against.
   * Returns the content of the persisted assistant row — the operator-visible artifact.
   */
  async function persistedReplyFor(transcript: SessionMessage[], streamed: string): Promise<string> {
    __setCreateResolvedAgentSession(async (options: any) => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          options.onText?.(streamed);
        }),
        dispose: vi.fn(),
        model: { provider: "openai", id: "vllm-model" },
        state: { messages: transcript },
      },
    }) as any);

    const manager = new ChatManager(store as any, "/tmp/rufu-230-ghost", agentStore as any);
    await manager.sendMessage("chat-001", "Is the approval in place?");

    const assistantCalls = store.addMessage.mock.calls.filter(([, input]) => input.role === "assistant");
    expect(assistantCalls).toHaveLength(1);
    return assistantCalls[0]![1].content;
  }

  it("excludes an aborted prefix ghost instead of persisting the doubled reply", async () => {
    // A Stop baked "Sk" into the transcript as its own (now honestly aborted) turn, then the retry
    // answered. Pre-fix the ghost join (21 chars) beat the streamed reply (17 chars) in the length
    // comparison and persisted "Sk\n\nSkúsim — priamo.".
    const content = await persistedReplyFor(
      [
        { role: "user", content: "Is the approval in place?" },
        assistant("Sk", "aborted"),
        assistant("Skúsim — priamo.", "stop"),
      ],
      "Skúsim — priamo.",
    );
    expect(content).toBe("Skúsim — priamo.");
    expect(content).not.toContain("Sk\n\n");
  });

  it("excludes a prefix ghost whose turn ended in an error", async () => {
    const content = await persistedReplyFor(
      [
        { role: "user", content: "Is the approval in place?" },
        assistant("Sk", "error"),
        assistant("Skúsim — priamo.", "stop"),
      ],
      "Skúsim — priamo.",
    );
    expect(content).toBe("Skúsim — priamo.");
  });

  it("excludes a strict-prefix ghost even when both turns report a clean stop", async () => {
    // Transcript shapes predating this task's aborted bake: the ghost carries "stop", so only the
    // strict-prefix rule can filter it.
    const content = await persistedReplyFor(
      [
        { role: "user", content: "Is the approval in place?" },
        assistant("Sk", "stop"),
        assistant("Skúsim — priamo.", "stop"),
      ],
      "Skúsim — priamo.",
    );
    expect(content).toBe("Skúsim — priamo.");
  });

  it("keeps every slice of a legitimate multi-part assistant turn", async () => {
    // Neither slice is a prefix of the other: this is a real two-block reply, so both must survive,
    // joined exactly as before ("\n\n").
    const content = await persistedReplyFor(
      [
        { role: "user", content: "Run both approved actions." },
        assistant("Let me check.", "stop"),
        assistant("Done.", "stop"),
      ],
      "Done.",
    );
    expect(content).toBe("Let me check.\n\nDone.");
  });
});
