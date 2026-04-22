// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateFnAgent } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  createFnAgent: mockCreateFnAgent,
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
import {
  setDiagnosticsSink,
  resetDiagnosticsSink,
} from "./ai-session-diagnostics.js";
import type { LogEntry } from "./ai-session-diagnostics.js";
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
    mockCreateFnAgent.mockImplementation(async () => createMockAgent([createQuestionJson()]));
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

      // Capture structured diagnostics via shared helper sink
      const loggedEntries: LogEntry[] = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedEntries.push({ level, scope, message, context, timestamp: new Date() });
      });

      const rehydrated = rehydrateFromStore(store as any);

      expect(rehydrated).toBe(1);
      expect(getMissionInterviewSession(goodRow.id)).toBeDefined();
      expect(getMissionInterviewSession(badRow.id)).toBeUndefined();
      // Assert structured diagnostic record
      expect(loggedEntries).toContainEqual(
        expect.objectContaining({
          level: "error",
          scope: "mission-interview",
          message: "Failed to rehydrate session",
          context: expect.objectContaining({
            sessionId: badRow.id,
            operation: "rehydrate",
          }),
        })
      );

      resetDiagnosticsSink();
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
      mockCreateFnAgent.mockImplementationOnce(async () =>
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
      const createFnAgentSpy = vi.fn(async () => resumedAgent);
      mockCreateFnAgent.mockImplementation(createFnAgentSpy);

      const result = await submitMissionInterviewResponse(
        row.id,
        { "q-2": "Need launch in 4 weeks" },
        "/tmp/project",
      );

      expect(result.type).toBe("question");
      if (result.type === "question") {
        expect(result.data.id).toBe("q-3");
      }
      expect(createFnAgentSpy).toHaveBeenCalledWith(
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
      mockCreateFnAgent.mockImplementationOnce(async () => resumedAgent);

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
      mockCreateFnAgent.mockImplementationOnce(async () => resumedAgent);

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

    it("logs error diagnostic when broadcast callback throws", () => {
      // Capture structured diagnostics via shared helper sink
      const loggedEntries: LogEntry[] = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedEntries.push({ level, scope, message, context, timestamp: new Date() });
      });

      const throwingCallback = vi.fn(() => {
        throw new Error("Callback failed");
      });
      missionInterviewStreamManager.subscribe("session-error-callback", throwingCallback);

      // Should not throw, but should log the error
      expect(() =>
        missionInterviewStreamManager.broadcast("session-error-callback", { type: "thinking", data: "test" })
      ).not.toThrow();

      expect(throwingCallback).toHaveBeenCalledTimes(1);
      // Assert structured diagnostic record
      expect(loggedEntries).toContainEqual(
        expect.objectContaining({
          level: "error",
          scope: "mission-interview",
          message: "Error broadcasting to client",
          context: expect.objectContaining({
            sessionId: "session-error-callback",
            operation: "broadcast",
          }),
        })
      );

      resetDiagnosticsSink();
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

    it("logs error diagnostic when no JSON candidate found before throwing", () => {
      // Capture structured diagnostics via shared helper sink
      const loggedEntries: LogEntry[] = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedEntries.push({ level, scope, message, context, timestamp: new Date() });
      });

      const input = "I'm not sure what to ask about this project.";
      expect(() => parseMissionAgentResponse(input)).toThrow("no valid JSON");

      expect(loggedEntries).toContainEqual(
        expect.objectContaining({
          level: "error",
          scope: "mission-interview",
          message: "No JSON candidate found in agent response",
          context: expect.objectContaining({
            inputSnippet: expect.stringContaining("I'm not sure"),
            operation: "parse-json",
          }),
        })
      );

      resetDiagnosticsSink();
    });

    it("logs error diagnostic when repair also fails before throwing", () => {
      // Capture structured diagnostics via shared helper sink
      const loggedEntries: LogEntry[] = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedEntries.push({ level, scope, message, context, timestamp: new Date() });
      });

      // Invalid JSON that repair cannot fix
      const input = '{"type":"question","data":{"id":q-1,"question":"What is this?"}';
      expect(() => parseMissionAgentResponse(input)).toThrow("Failed to parse AI response");

      expect(loggedEntries).toContainEqual(
        expect.objectContaining({
          level: "error",
          scope: "mission-interview",
          message: "Failed to parse agent response (repair also failed)",
          context: expect.objectContaining({
            inputSnippet: expect.stringContaining('{"type":"question"'),
            operation: "parse-json-repair",
          }),
        })
      );

      resetDiagnosticsSink();
    });

    it("logs error diagnostic for invalid response structure before throwing", () => {
      // Capture structured diagnostics via shared helper sink
      const loggedEntries: LogEntry[] = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedEntries.push({ level, scope, message, context, timestamp: new Date() });
      });

      const input = '{"type":"unknown","data":null}';
      expect(() => parseMissionAgentResponse(input)).toThrow("invalid response structure");

      expect(loggedEntries).toContainEqual(
        expect.objectContaining({
          level: "error",
          scope: "mission-interview",
          message: "Invalid response structure from AI",
          context: expect.objectContaining({
            parsedSnippet: expect.stringContaining('"type":"unknown"'),
            operation: "parse-validate",
          }),
        })
      );

      resetDiagnosticsSink();
    });
  });

  describe("custom errors", () => {
    it("sets expected error names", () => {
      expect(new RateLimitError("rate").name).toBe("RateLimitError");
      expect(new SessionNotFoundError("missing").name).toBe("SessionNotFoundError");
      expect(new InvalidSessionStateError("bad").name).toBe("InvalidSessionStateError");
    });
  });

  describe("prompt override regression", () => {
    const customPrompt = "You are a custom mission interview assistant.";
    const defaultPromptStart = "You are a mission planning assistant";

    it("uses default prompt when no overrides provided", async () => {
      const mockAgent = createMockAgent([createQuestionJson()]);
      mockCreateFnAgent.mockImplementationOnce(async () => mockAgent);

      await createMissionInterviewSession("192.168.1.1", "Test Mission", "/tmp/project");

      await waitForCurrentQuestion(await createMissionInterviewSession("192.168.1.1", "Test Mission 2", "/tmp/project"));

      // The first session starts asynchronously, so we need to wait
      // Check the createFnAgent call was made with default prompt
      expect(mockCreateFnAgent).toHaveBeenCalled();
      const lastCall = mockCreateFnAgent.mock.calls[mockCreateFnAgent.mock.calls.length - 1];
      expect(lastCall[0].systemPrompt).toMatch(/^You are a mission planning assistant/);
    });

    it("uses override prompt when promptOverrides provided", async () => {
      const mockAgent = createMockAgent([createQuestionJson()]);
      mockCreateFnAgent.mockImplementationOnce(async () => mockAgent);

      const sessionId = await createMissionInterviewSession(
        "192.168.1.2",
        "Test Mission",
        "/tmp/project",
        { "mission-interview-system": customPrompt },
      );
      await waitForCurrentQuestion(sessionId);

      expect(mockCreateFnAgent).toHaveBeenCalled();
      const lastCall = mockCreateFnAgent.mock.calls[mockCreateFnAgent.mock.calls.length - 1];
      expect(lastCall[0].systemPrompt).toBe(customPrompt);
    });

    it("falls back to default prompt when override is empty string", async () => {
      const mockAgent = createMockAgent([createQuestionJson()]);
      mockCreateFnAgent.mockImplementationOnce(async () => mockAgent);

      const sessionId = await createMissionInterviewSession(
        "192.168.1.3",
        "Test Mission",
        "/tmp/project",
        { "mission-interview-system": "" },
      );
      await waitForCurrentQuestion(sessionId);

      expect(mockCreateFnAgent).toHaveBeenCalled();
      const lastCall = mockCreateFnAgent.mock.calls[mockCreateFnAgent.mock.calls.length - 1];
      expect(lastCall[0].systemPrompt).toMatch(/^You are a mission planning assistant/);
    });

    it("passes prompt overrides through submitMissionInterviewResponse for rehydrated sessions", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({ id: "mission-prompt-override-1", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);
      expect(rehydrateFromStore(store as any)).toBe(1);

      const resumedAgent = createMockAgent([createQuestionJson("q-override")]);
      mockCreateFnAgent.mockImplementationOnce(async () => resumedAgent);

      await submitMissionInterviewResponse(
        row.id,
        { "q-2": "Test response" },
        "/tmp/project",
        { "mission-interview-system": customPrompt },
      );

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: customPrompt,
        }),
      );
    });

    it("passes prompt overrides through retryMissionInterviewSession", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({
        id: "mission-retry-prompt-override",
        status: "error",
        error: "Test error",
        conversationHistory: JSON.stringify([
          {
            question: { id: "q-1", type: "text", question: "Goal?", description: "scope" },
            response: { "q-1": "Build app" },
          },
        ]),
      });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const resumedAgent = createMockAgent([createQuestionJson("q-retry")]);
      mockCreateFnAgent.mockImplementationOnce(async () => resumedAgent);

      await retryMissionInterviewSession(
        row.id,
        "/tmp/project",
        { "mission-interview-system": customPrompt },
      );

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: customPrompt,
        }),
      );
    });

    it("does not introduce unexpected model/provider override fields in createFnAgent", async () => {
      const mockAgent = createMockAgent([createQuestionJson()]);
      mockCreateFnAgent.mockImplementationOnce(async () => mockAgent);

      const sessionId = await createMissionInterviewSession(
        "192.168.1.4",
        "Test Mission",
        "/tmp/project",
        { "mission-interview-system": customPrompt },
      );
      await waitForCurrentQuestion(sessionId);

      expect(mockCreateFnAgent).toHaveBeenCalled();
      const lastCall = mockCreateFnAgent.mock.calls[mockCreateFnAgent.mock.calls.length - 1];
      const agentConfig = lastCall[0];

      // Verify only expected fields are present
      expect(agentConfig).toHaveProperty("cwd");
      expect(agentConfig).toHaveProperty("systemPrompt");
      expect(agentConfig).toHaveProperty("tools");
      expect(agentConfig).toHaveProperty("onThinking");
      expect(agentConfig).toHaveProperty("onText");

      // Verify stream callbacks use the active session id
      const broadcastSpy = vi.spyOn(missionInterviewStreamManager, "broadcast").mockReturnValue(1);
      agentConfig.onText("Hello");
      expect(broadcastSpy).toHaveBeenCalledWith(sessionId, { type: "text", data: "Hello" });

      agentConfig.onThinking("thinking...");
      expect(broadcastSpy).toHaveBeenCalledWith(sessionId, { type: "thinking", data: "thinking..." });
      broadcastSpy.mockRestore();

      // Verify no unexpected model override fields
      expect(agentConfig).not.toHaveProperty("modelProvider");
      expect(agentConfig).not.toHaveProperty("modelId");
      expect(agentConfig).not.toHaveProperty("provider");
      expect(agentConfig).not.toHaveProperty("model");
    });

    it("prompt overrides do not affect other prompt keys", async () => {
      const mockAgent = createMockAgent([createQuestionJson()]);
      mockCreateFnAgent.mockImplementationOnce(async () => mockAgent);

      // Provide overrides for a different key only
      const sessionId = await createMissionInterviewSession(
        "192.168.1.5",
        "Test Mission",
        "/tmp/project",
        { "planning-system": "Should not affect mission interview" },
      );
      await waitForCurrentQuestion(sessionId);

      expect(mockCreateFnAgent).toHaveBeenCalled();
      const lastCall = mockCreateFnAgent.mock.calls[mockCreateFnAgent.mock.calls.length - 1];
      // Mission interview should use its own default prompt, not affected by planning-system override
      expect(lastCall[0].systemPrompt).toMatch(/^You are a mission planning assistant/);
    });

    it("falls back to default prompt on retry when promptOverrides is undefined", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({
        id: "mission-retry-no-override",
        status: "error",
        error: "Test error",
        conversationHistory: JSON.stringify([
          {
            question: { id: "q-1", type: "text", question: "Goal?", description: "scope" },
            response: { "q-1": "Build app" },
          },
        ]),
      });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const resumedAgent = createMockAgent([createQuestionJson("q-retry")]);
      mockCreateFnAgent.mockImplementationOnce(async () => resumedAgent);

      await retryMissionInterviewSession(row.id, "/tmp/project", undefined);

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining("mission planning assistant"),
        }),
      );
    });

    it("falls back to default prompt through submitMissionInterviewResponse for rehydrated sessions when overrides undefined", async () => {
      const store = new MockAiSessionStore();
      const row = buildMissionRow({ id: "mission-submit-no-override", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);
      expect(rehydrateFromStore(store as any)).toBe(1);

      const resumedAgent = createMockAgent([createQuestionJson("q-fallback")]);
      mockCreateFnAgent.mockImplementationOnce(async () => resumedAgent);

      await submitMissionInterviewResponse(row.id, { "q-2": "Test" }, "/tmp/project", undefined);

      expect(mockCreateFnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining("mission planning assistant"),
        }),
      );
    });

    it("falls back to default prompt when promptOverrides is empty object", async () => {
      const mockAgent = createMockAgent([createQuestionJson()]);
      mockCreateFnAgent.mockImplementationOnce(async () => mockAgent);

      const sessionId = await createMissionInterviewSession(
        "192.168.1.6",
        "Test Mission",
        "/tmp/project",
        {},
      );
      await waitForCurrentQuestion(sessionId);

      expect(mockCreateFnAgent).toHaveBeenCalled();
      const lastCall = mockCreateFnAgent.mock.calls[mockCreateFnAgent.mock.calls.length - 1];
      expect(lastCall[0].systemPrompt).toMatch(/^You are a mission planning assistant/);
    });
  });
});
