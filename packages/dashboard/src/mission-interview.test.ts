// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateKbAgent } = vi.hoisted(() => ({
  mockCreateKbAgent: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  createKbAgent: mockCreateKbAgent,
}));

import {
  __resetMissionInterviewState,
  cancelMissionInterviewSession,
  checkRateLimit,
  cleanupMissionInterviewSession,
  createMissionInterviewSession,
  retryMissionInterviewSession,
  getMissionInterviewSession,
  getMissionInterviewSummary,
  getRateLimitResetTime,
  InvalidSessionStateError,
  missionInterviewStreamManager,
  parseMissionAgentResponse,
  rehydrateFromStore,
  setAiSessionStore,
  RateLimitError,
  SessionNotFoundError,
  submitMissionInterviewResponse,
} from "./mission-interview.js";
import { EventEmitter } from "node:events";
import type { AiSessionRow } from "./ai-session-store.js";

function createQuestionJson(id = "q-1"): string {
  return JSON.stringify({
    type: "question",
    data: {
      id,
      type: "text",
      question: "What should we build first?",
      description: "Initial scope",
    },
  });
}

function createCompleteJson(): string {
  return JSON.stringify({
    type: "complete",
    data: {
      missionTitle: "Mission Ready",
      missionDescription: "Complete plan",
      milestones: [
        {
          title: "Milestone 1",
          slices: [
            {
              title: "Slice 1",
              features: [
                { title: "Feature 1", acceptanceCriteria: "Works" },
              ],
            },
          ],
        },
      ],
    },
  });
}

function createMockAgent(responses: string[]) {
  const queue = [...responses];
  const messages: Array<{ role: string; content: string }> = [];

  return {
    session: {
      state: { messages },
      prompt: vi.fn(async () => {
        const response = queue.shift() ?? createQuestionJson("q-fallback");
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };
}

async function waitForCurrentQuestion(sessionId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (getMissionInterviewSession(sessionId)?.currentQuestion) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for currentQuestion");
}

class MockAiSessionStore extends EventEmitter {
  rows = new Map<string, AiSessionRow>();

  upsert(row: AiSessionRow): void {
    this.rows.set(row.id, row);
  }

  updateThinking(id: string, thinkingOutput: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, { ...row, thinkingOutput, updatedAt: new Date().toISOString() });
  }

  delete(id: string): void {
    this.rows.delete(id);
    this.emit("ai_session:deleted", id);
  }

  get(id: string): AiSessionRow | null {
    return this.rows.get(id) ?? null;
  }

  listRecoverable(): AiSessionRow[] {
    return [...this.rows.values()].filter(
      (row) => row.status === "awaiting_input" || row.status === "generating" || row.status === "error",
    );
  }

  on(event: "ai_session:deleted", listener: (sessionId: string) => void): this {
    return super.on(event, listener);
  }

  off(event: "ai_session:deleted", listener: (sessionId: string) => void): this {
    return super.off(event, listener);
  }
}

function buildMissionRow(
  overrides: Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "status">,
): AiSessionRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    type: overrides.type ?? "mission_interview",
    status: overrides.status,
    title: overrides.title ?? "Mission planning",
    inputPayload:
      overrides.inputPayload ??
      JSON.stringify({ ip: "127.0.0.1", missionId: "mission-123", missionTitle: "Mission planning" }),
    conversationHistory:
      overrides.conversationHistory ??
      JSON.stringify([
        {
          question: {
            id: "q-1",
            type: "text",
            question: "What is your goal?",
            description: "scope",
          },
          response: { "q-1": "Ship a dashboard" },
        },
      ]),
    currentQuestion:
      overrides.currentQuestion ??
      JSON.stringify({
        id: "q-2",
        type: "text",
        question: "Any constraints?",
        description: "details",
      }),
    result: overrides.result ?? null,
    thinkingOutput: overrides.thinkingOutput ?? "thinking",
    error: overrides.error ?? null,
    projectId: overrides.projectId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe("mission-interview module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetMissionInterviewState();
    mockCreateKbAgent.mockImplementation(async () => createMockAgent([createQuestionJson()]));
  });

  describe("session lifecycle", () => {
    it("creates, retrieves, and cleans up a session", async () => {
      const sessionId = await createMissionInterviewSession("127.0.0.1", "Launch platform", "/tmp/project");

      const session = getMissionInterviewSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.missionTitle).toBe("Launch platform");

      cleanupMissionInterviewSession(sessionId);
      expect(getMissionInterviewSession(sessionId)).toBeUndefined();
    });

    it("cancels a session and throws when canceling missing session", async () => {
      const sessionId = await createMissionInterviewSession("127.0.0.2", "Cancel mission", "/tmp/project");
      await waitForCurrentQuestion(sessionId);

      await cancelMissionInterviewSession(sessionId);
      expect(getMissionInterviewSession(sessionId)).toBeUndefined();

      await expect(cancelMissionInterviewSession(sessionId)).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });

  describe("rate limiting", () => {
    it("enforces max sessions per IP and exposes reset time", async () => {
      const ip = "10.0.0.1";

      for (let i = 0; i < 5; i++) {
        await createMissionInterviewSession(ip, `Mission ${i}`, "/tmp/project");
      }

      await expect(createMissionInterviewSession(ip, "Mission 6", "/tmp/project")).rejects.toBeInstanceOf(RateLimitError);
      expect(getRateLimitResetTime(ip)).toBeInstanceOf(Date);
    });

    it("checkRateLimit tracks allowance and lockout", () => {
      const ip = "10.0.0.2";
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit(ip)).toBe(true);
      }
      expect(checkRateLimit(ip)).toBe(false);
    });
  });

  describe("rehydration and session lookup", () => {
    it("rehydrates mission interview sessions from recoverable rows", () => {
      const store = new MockAiSessionStore();
      const missionRow = buildMissionRow({ id: "mission-rehydrate-1", status: "awaiting_input" });
      const planningRow = buildMissionRow({ id: "planning-rehydrate-1", status: "awaiting_input", type: "planning" });
      store.rows.set(missionRow.id, missionRow);
      store.rows.set(planningRow.id, planningRow);

      const rehydrated = rehydrateFromStore(store as any);

      expect(rehydrated).toBe(1);
      const session = getMissionInterviewSession(missionRow.id);
      expect(session).toBeDefined();
      expect(session?.id).toBe(missionRow.id);
      expect(session?.ip).toBe("127.0.0.1");
      expect(session?.missionId).toBe("mission-123");
      expect(session?.currentQuestion?.id).toBe("q-2");
      expect(session?.agent).toBeUndefined();
      expect(getMissionInterviewSession(planningRow.id)).toBeUndefined();
    });

    it("skips corrupted rows and continues with valid rows", () => {
      const store = new MockAiSessionStore();
      const goodRow = buildMissionRow({ id: "mission-good", status: "awaiting_input" });
      const badRow = buildMissionRow({
        id: "mission-bad",
        status: "awaiting_input",
        conversationHistory: "{bad-json",
      });
      store.rows.set(goodRow.id, goodRow);
      store.rows.set(badRow.id, badRow);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const rehydrated = rehydrateFromStore(store as any);

      expect(rehydrated).toBe(1);
      expect(getMissionInterviewSession(goodRow.id)).toBeDefined();
      expect(getMissionInterviewSession(badRow.id)).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        `[mission-interview] Failed to rehydrate session ${badRow.id}:`,
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it("falls through to SQLite when in-memory session is missing", () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({ id: "mission-fallthrough", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const session = getMissionInterviewSession(row.id);

      expect(session).toBeDefined();
      expect(session?.missionTitle).toBe("Mission planning");
      expect(session?.agent).toBeUndefined();
    });

    it("returns in-memory session before SQLite fallback", () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({ id: "mission-memory-first", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);
      rehydrateFromStore(store as any);

      store.rows.set(
        row.id,
        buildMissionRow({
          id: row.id,
          status: "awaiting_input",
          inputPayload: JSON.stringify({ ip: "10.0.0.5", missionId: "mission-xyz", missionTitle: "SQLite title" }),
        }),
      );

      const getSpy = vi.spyOn(store, "get");
      const session = getMissionInterviewSession(row.id);

      expect(session?.missionTitle).toBe("Mission planning");
      expect(getSpy).not.toHaveBeenCalled();
    });

    it("returns undefined when session exists nowhere", () => {
      const store = new MockAiSessionStore();
      setAiSessionStore(store as any);

      expect(getMissionInterviewSession("missing-session")).toBeUndefined();
    });
  });

  describe("submitMissionInterviewResponse", () => {
    it("processes response and returns completed summary", async () => {
      mockCreateKbAgent.mockImplementationOnce(async () =>
        createMockAgent([createQuestionJson("q-plan"), createCompleteJson()]),
      );

      const sessionId = await createMissionInterviewSession("172.16.0.1", "Build mission", "/tmp/project");
      await waitForCurrentQuestion(sessionId);

      const session = getMissionInterviewSession(sessionId);
      const questionId = session?.currentQuestion?.id;
      expect(questionId).toBe("q-plan");

      const result = await submitMissionInterviewResponse(sessionId, {
        [questionId as string]: "We should prioritize auth first",
      });

      expect(result.type).toBe("complete");
      expect(getMissionInterviewSummary(sessionId)?.missionTitle).toBe("Mission Ready");
    });

    it("reconstructs agent for a rehydrated session and continues conversation", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({ id: "mission-rehydrated-1", status: "awaiting_input" });
      store.rows.set(row.id, row);

      setAiSessionStore(store as any);
      expect(rehydrateFromStore(store as any)).toBe(1);

      const resumedAgent = createMockAgent([
        createQuestionJson("q-context"),
        JSON.stringify({
          type: "question",
          data: {
            id: "q-3",
            type: "text",
            question: "What timeline do you have?",
            description: "delivery",
          },
        }),
      ]);
      const createKbAgentSpy = vi.fn(async () => resumedAgent);
      mockCreateKbAgent.mockImplementation(createKbAgentSpy);

      const result = await submitMissionInterviewResponse(
        row.id,
        { "q-2": "Need launch in 4 weeks" },
        "/tmp/project",
      );

      expect(result.type).toBe("question");
      if (result.type === "question") {
        expect(result.data.id).toBe("q-3");
      }
      expect(createKbAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp/project",
          systemPrompt: expect.stringContaining("mission planning assistant"),
        }),
      );
      expect(resumedAgent.session.prompt).toHaveBeenCalledTimes(2);
      expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain("Previous conversation summary");
      expect(resumedAgent.session.prompt.mock.calls[1]?.[0]).toContain("Any constraints?");
      expect(getMissionInterviewSession(row.id)?.agent).toBeDefined();
    });

    it("throws SessionNotFoundError for unknown session", async () => {
      await expect(submitMissionInterviewResponse("missing", {})).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it("throws InvalidSessionStateError when no active question", async () => {
      const sessionId = await createMissionInterviewSession("172.16.0.2", "No question", "/tmp/project");
      await waitForCurrentQuestion(sessionId);

      const session = getMissionInterviewSession(sessionId);
      if (!session) throw new Error("session should exist");
      session.currentQuestion = undefined;

      await expect(submitMissionInterviewResponse(sessionId, {})).rejects.toBeInstanceOf(InvalidSessionStateError);
    });

    it("throws InvalidSessionStateError when rootDir is missing for a rehydrated session", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({ id: "mission-rehydrated-2", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);
      rehydrateFromStore(store as any);

      await expect(submitMissionInterviewResponse(row.id, { "q-2": "answer" })).rejects.toThrow(
        "cannot be resumed without project context",
      );
    });
  });

  describe("retryMissionInterviewSession", () => {
    it("rehydrates errored sessions and retries the last response", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({
        id: "mission-retry-1",
        status: "error",
        error: "Transient outage",
        conversationHistory: JSON.stringify([
          {
            question: {
              id: "q-1",
              type: "text",
              question: "What is your goal?",
              description: "scope",
            },
            response: { "q-1": "Ship a dashboard" },
          },
        ]),
      });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const resumedAgent = createMockAgent([createQuestionJson("q-retry")]);
      mockCreateKbAgent.mockImplementationOnce(async () => resumedAgent);

      await retryMissionInterviewSession(row.id, "/tmp/project");

      expect(resumedAgent.session.prompt).toHaveBeenCalledTimes(1);
      expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain("What is your goal?");
      expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain("Ship a dashboard");

      expect(getMissionInterviewSession(row.id)?.currentQuestion?.id).toBe("q-retry");
      expect(store.get(row.id)?.status).toBe("awaiting_input");
      expect(store.get(row.id)?.error).toBeNull();
    });

    it("replays the initial mission prompt when history is empty", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({
        id: "mission-retry-2",
        status: "error",
        error: "First turn failed",
        inputPayload: JSON.stringify({
          ip: "127.0.0.1",
          missionId: "mission-999",
          missionTitle: "Launch alpha",
        }),
        conversationHistory: "[]",
        currentQuestion: null,
      });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const resumedAgent = createMockAgent([createQuestionJson("q-first")]);
      mockCreateKbAgent.mockImplementationOnce(async () => resumedAgent);

      await retryMissionInterviewSession(row.id, "/tmp/project");

      expect(resumedAgent.session.prompt).toHaveBeenCalledTimes(1);
      expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain('I want to plan a mission: "Launch alpha"');
      expect(store.get(row.id)?.status).toBe("awaiting_input");
    });

    it("throws when retrying a non-error mission session", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({ id: "mission-not-error", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      await expect(retryMissionInterviewSession(row.id, "/tmp/project")).rejects.toBeInstanceOf(
        InvalidSessionStateError,
      );
    });
  });

  describe("stream manager", () => {
    it("subscribes, broadcasts, unsubscribes, and cleans up", () => {
      const callback = vi.fn();
      const unsubscribe = missionInterviewStreamManager.subscribe("session-1", callback);

      expect(missionInterviewStreamManager.hasSubscribers("session-1")).toBe(true);

      const eventId = missionInterviewStreamManager.broadcast("session-1", { type: "thinking", data: "analyzing" });
      expect(eventId).toBe(1);
      expect(callback).toHaveBeenCalledWith({ type: "thinking", data: "analyzing" }, 1);

      unsubscribe();
      expect(missionInterviewStreamManager.hasSubscribers("session-1")).toBe(false);

      missionInterviewStreamManager.cleanupSession("session-1");
      expect(missionInterviewStreamManager.hasSubscribers("session-1")).toBe(false);
    });

    it("returns buffered events since last event id", () => {
      const sessionId = "session-buffered";

      missionInterviewStreamManager.broadcast(sessionId, { type: "thinking", data: "delta-1" });
      missionInterviewStreamManager.broadcast(sessionId, { type: "thinking", data: "delta-2" });
      missionInterviewStreamManager.broadcast(sessionId, { type: "complete" });

      const buffered = missionInterviewStreamManager.getBufferedEvents(sessionId, 1);
      expect(buffered).toHaveLength(2);
      expect(buffered.map((event) => event.id)).toEqual([2, 3]);
      expect(buffered[1]).toMatchObject({ event: "complete", data: "{}" });
    });

    it("clears buffered events on cleanup", () => {
      const sessionId = "session-cleanup";
      missionInterviewStreamManager.broadcast(sessionId, { type: "thinking", data: "delta" });

      expect(missionInterviewStreamManager.getBufferedEvents(sessionId, 0)).toHaveLength(1);
      missionInterviewStreamManager.cleanupSession(sessionId);
      expect(missionInterviewStreamManager.getBufferedEvents(sessionId, 0)).toEqual([]);
    });
  });

  describe("response parsing", () => {
    it("parses direct JSON question responses", () => {
      const parsed = parseMissionAgentResponse(createQuestionJson("q-direct"));
      expect(parsed.type).toBe("question");
      if (parsed.type === "question") {
        expect(parsed.data.id).toBe("q-direct");
      }
    });

    it("parses markdown-wrapped complete responses", () => {
      const wrapped = `\n\`\`\`json\n${createCompleteJson()}\n\`\`\``;
      const parsed = parseMissionAgentResponse(wrapped);
      expect(parsed.type).toBe("complete");
    });

    it("parses embedded JSON inside prose", () => {
      const text = `Here is the plan output:\n${createQuestionJson("q-embedded")}\nThanks.`;
      const parsed = parseMissionAgentResponse(text);
      expect(parsed.type).toBe("question");
      if (parsed.type === "question") {
        expect(parsed.data.id).toBe("q-embedded");
      }
    });

    it("repairs and parses JSON with trailing commas", () => {
      const malformed = '{"type":"question","data":{"id":"q-fix","type":"text","question":"Q?",},}';
      const parsed = parseMissionAgentResponse(malformed);
      expect(parsed.type).toBe("question");
    });

    it("throws on invalid response structure", () => {
      expect(() =>
        parseMissionAgentResponse(JSON.stringify({ type: "unknown", data: null })),
      ).toThrow("invalid response structure");
    });
  });

  describe("custom errors", () => {
    it("sets expected error names", () => {
      expect(new RateLimitError("rate").name).toBe("RateLimitError");
      expect(new SessionNotFoundError("missing").name).toBe("SessionNotFoundError");
      expect(new InvalidSessionStateError("bad").name).toBe("InvalidSessionStateError");
    });
  });
});
