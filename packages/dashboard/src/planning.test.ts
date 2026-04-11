import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { Database, TaskStore } from "@fusion/core";
import {
  createSession,
  createSessionWithAgent,
  submitResponse,
  retrySession,
  cancelSession,
  getSession,
  getCurrentQuestion,
  getSummary,
  cleanupSession,
  planningStreamManager,
  checkRateLimit,
  getRateLimitResetTime,
  __resetPlanningState,
  __setCreateKbAgent,
  rehydrateFromStore,
  setAiSessionStore,
  RateLimitError,
  SessionNotFoundError,
  InvalidSessionStateError,
  parseAgentResponse,
  generateSubtasksFromPlanning,
  formatInterviewQA,
  SESSION_TTL_MS,
} from "./planning.js";
import { createApiRoutes } from "./routes.js";
import { request, get } from "./test-request.js";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";
import { AiSessionStore, type AiSessionRow } from "./ai-session-store.js";

// ── Mock Agent Factory ──────────────────────────────────────────────────────

/**
 * Creates a mock AI agent that responds with predefined JSON responses.
 * Each call to `prompt()` consumes the next response in the array.
 */
function createMockAgent(responses: string[]) {
  const messages: Array<{ role: string; content: string }> = [];
  let callIndex = 0;

  return {
    session: {
      state: { messages },
      prompt: vi.fn(async (msg: string) => {
        messages.push({ role: "user", content: msg });
        const response = responses[callIndex++] ?? responses[responses.length - 1];
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };
}

/** Standard AI responses for a 3-question flow */
const STANDARD_QUESTION_RESPONSES = [
  JSON.stringify({
    type: "question",
    data: {
      id: "q-scope",
      type: "single_select",
      question: "What is the scope of this plan?",
      description: "This helps estimate the size and complexity of the task.",
      options: [
        { id: "small", label: "Small", description: "Quick" },
        { id: "medium", label: "Medium", description: "Standard" },
        { id: "large", label: "Large", description: "Complex" },
      ],
    },
  }),
  JSON.stringify({
    type: "question",
    data: {
      id: "q-requirements",
      type: "text",
      question: "What are the key requirements?",
      description: "List acceptance criteria.",
    },
  }),
  JSON.stringify({
    type: "question",
    data: {
      id: "q-confirm",
      type: "confirm",
      question: "Are there specific technologies to use?",
      description: "Answer yes if you have preferences.",
    },
  }),
  JSON.stringify({
    type: "complete",
    data: {
      title: "Build Auth System",
      description: "Build a user authentication system\n\nRequirements: Standard implementation\n\nGenerated via Planning Mode",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: ["Implementation", "Tests", "Documentation"],
    },
  }),
];

/** Root dir for all test sessions */
const TEST_ROOT_DIR = "/test/project";

// Counter for unique IPs per test
let ipCounter = 0;
function getUniqueIp(): string {
  return `127.0.0.${++ipCounter}`;
}

/**
 * Helper: set up a fresh mock agent for the next createSession call.
 * Returns the agent so tests can inspect `.session.prompt` calls.
 */
function setupMockAgent(responses?: string[]) {
  const agent = createMockAgent(responses ?? STANDARD_QUESTION_RESPONSES);
  __setCreateKbAgent(async () => agent);
  return agent;
}

function setupMockStreamingAgent(options?: {
  responses?: string[];
  thinkingPerPrompt?: string[];
}) {
  const responses = options?.responses ?? STANDARD_QUESTION_RESPONSES;
  const thinkingPerPrompt = options?.thinkingPerPrompt ?? [];
  let promptIndex = 0;

  const createKbAgentSpy = vi.fn(async (agentOptions?: { onThinking?: (delta: string) => void }) => {
    const messages: Array<{ role: string; content: string }> = [];

    return {
      session: {
        state: { messages },
        prompt: vi.fn(async (message: string) => {
          messages.push({ role: "user", content: message });
          const thinking = thinkingPerPrompt[promptIndex];
          if (thinking) {
            agentOptions?.onThinking?.(thinking);
          }
          const response = responses[promptIndex] ?? responses[responses.length - 1];
          messages.push({ role: "assistant", content: response });
          promptIndex += 1;
        }),
        dispose: vi.fn(),
      },
    };
  });

  __setCreateKbAgent(createKbAgentSpy as any);
  return { createKbAgentSpy };
}

class MockAiSessionStore extends EventEmitter {
  rows = new Map<string, AiSessionRow>();

  upsert(row: AiSessionRow): void {
    this.rows.set(row.id, row);
  }

  updateThinking(id: string, thinkingOutput: string): void {
    const row = this.rows.get(id);
    if (!row) {
      return;
    }

    this.rows.set(id, {
      ...row,
      thinkingOutput,
      updatedAt: new Date().toISOString(),
    });
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

function buildPlanningRow(
  overrides: Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "status">,
): AiSessionRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    type: "planning",
    status: overrides.status,
    title: overrides.title ?? "Recovered planning session",
    inputPayload:
      overrides.inputPayload ??
      JSON.stringify({ ip: "127.0.0.1", initialPlan: "Recovered planning session" }),
    conversationHistory:
      overrides.conversationHistory ??
      JSON.stringify([
        {
          question: {
            id: "q-existing",
            type: "text",
            question: "What should we build?",
            description: "baseline",
          },
          response: { "q-existing": "A useful feature" },
        },
      ]),
    currentQuestion:
      overrides.currentQuestion ??
      JSON.stringify({
        id: "q-next",
        type: "text",
        question: "Any constraints?",
        description: "detail",
      }),
    result: overrides.result ?? null,
    thinkingOutput: overrides.thinkingOutput ?? "thinking",
    error: overrides.error ?? null,
    projectId: overrides.projectId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe("planning module", () => {
  const initialPlan = "Build a user authentication system";

  // Ensure the engine is loaded before any tests run.
  // The module-level `engineReady` promise may still be resolving
  // (importing @fusion/engine) when the first test starts.
  // We set the mock BEFORE awaiting, so initEngine skips the real import
  // on subsequent calls (though the first call may already be in-flight).
  beforeAll(async () => {
    // Wait for the initial engine load to complete (could be real or failed)
    // by importing the module and waiting for its side effects.
    // Then set our mock which will take effect for all test calls.
    setupMockAgent();
  });

  beforeEach(() => {
    __resetPlanningState();
    setupMockAgent();
  });

  afterEach(() => {
    __setCreateKbAgent(undefined as any);
  });

  describe("createSession", () => {
    it("creates a session with valid initial plan", async () => {
      const mockIp = getUniqueIp();
      const result = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      expect(result.sessionId).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
      expect(result.firstQuestion).toBeDefined();
      expect(result.firstQuestion.id).toBe("q-scope");
      expect(result.firstQuestion.type).toBe("single_select");
    });

    it("throws if rootDir is not provided", async () => {
      const mockIp = getUniqueIp();
      await expect(createSession(mockIp, initialPlan)).rejects.toThrow("rootDir is required");
    });

    it("enforces rate limiting", async () => {
      const mockIp = getUniqueIp();
      // Create max sessions (5 per hour)
      for (let i = 0; i < 5; i++) {
        await createSession(mockIp, `${initialPlan} ${i}`, undefined, TEST_ROOT_DIR);
      }

      // 6th session should fail
      await expect(createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR)).rejects.toThrow(RateLimitError);
    });

    it("allows new sessions after rate limit window expires", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const mockIp = getUniqueIp();
        // Create max sessions
        for (let i = 0; i < 5; i++) {
          await createSession(mockIp, `${initialPlan} ${i}`, undefined, TEST_ROOT_DIR);
        }

        // Advance time by 1 hour + 1 minute
        vi.advanceTimersByTime(61 * 60 * 1000);

        // Should now be able to create a new session
        const result = await createSession(mockIp, "New plan after reset", undefined, TEST_ROOT_DIR);
        expect(result.sessionId).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("generates different session IDs for each session", async () => {
      const mockIp = getUniqueIp();
      const result1 = await createSession(mockIp, "Plan 1", undefined, TEST_ROOT_DIR);
      const result2 = await createSession(mockIp, "Plan 2", undefined, TEST_ROOT_DIR);

      expect(result1.sessionId).not.toBe(result2.sessionId);
    });

    it("stores the AI agent on the session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      const session = getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.agent).toBeDefined();
    });

    it("cleans up session on agent failure", async () => {
      __setCreateKbAgent(async () => {
        throw new Error("Agent creation failed");
      });

      const mockIp = getUniqueIp();
      await expect(createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR)).rejects.toThrow(
        "Agent creation failed"
      );
    });

    it("cleans up session when AI returns unparseable output", async () => {
      setupMockAgent(["I am not JSON at all"]);

      const mockIp = getUniqueIp();
      await expect(createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR)).rejects.toThrow(
        "Failed to get first question from AI"
      );
    });

    it("handles AI returning a summary instead of a first question", async () => {
      setupMockAgent([
        JSON.stringify({
          type: "complete",
          data: {
            title: "Auth System",
            description: "Build auth",
            suggestedSize: "M",
            suggestedDependencies: [],
            keyDeliverables: ["Login"],
          },
        }),
      ]);

      const mockIp = getUniqueIp();
      const result = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      // Should return a confirm question wrapping the summary
      expect(result.firstQuestion.type).toBe("confirm");
      expect(result.firstQuestion.id).toBe("q-direct-summary");
      expect(result.firstQuestion.question).toContain("Auth System");
    });
  });

  describe("createSessionWithAgent", () => {
    it("passes planning model override to createKbAgent when provided", async () => {
      const createKbAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateKbAgent(createKbAgentSpy as any);

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        "google",
        "gemini-2.5-pro",
      );

      expect(sessionId).toBeDefined();

      await vi.waitFor(() => {
        expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      expect(createKbAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "google",
          defaultModelId: "gemini-2.5-pro",
        }),
      );
    });

    it("creates agent without model overrides when none provided", async () => {
      const createKbAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateKbAgent(createKbAgentSpy as any);

      const sessionId = await createSessionWithAgent(getUniqueIp(), "Build auth system", TEST_ROOT_DIR);

      expect(sessionId).toBeDefined();

      await vi.waitFor(() => {
        expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.defaultProvider).toBeUndefined();
      expect(callArg?.defaultModelId).toBeUndefined();
    });

    it("uses custom prompt from promptOverrides when provided", async () => {
      const createKbAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateKbAgent(createKbAgentSpy as any);

      const customPrompt = "Custom planning prompt with specific guidelines...";
      const promptOverrides = { "planning-system": customPrompt };

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        undefined,
        undefined,
        promptOverrides,
      );

      expect(sessionId).toBeDefined();

      await vi.waitFor(() => {
        expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.systemPrompt).toBe(customPrompt);
    });

    it("falls back to default prompt when promptOverrides is undefined", async () => {
      const createKbAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateKbAgent(createKbAgentSpy as any);

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        undefined,
        undefined,
        undefined,
      );

      expect(sessionId).toBeDefined();

      await vi.waitFor(() => {
        expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.systemPrompt).toContain("planning assistant");
    });

    it("falls back to default prompt when promptOverrides does not contain planning key", async () => {
      const createKbAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateKbAgent(createKbAgentSpy as any);

      // Provide an override for a different key
      const promptOverrides = { "triage-welcome": "Some other prompt" };

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        undefined,
        undefined,
        promptOverrides,
      );

      expect(sessionId).toBeDefined();

      await vi.waitFor(() => {
        expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.systemPrompt).toContain("planning assistant");
    });
  });

  describe("submitResponse", () => {
    it("processes response and returns next question", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      const response = await submitResponse(sessionId, { scope: "medium" });

      expect(response.type).toBe("question");
      if (response.type === "question") {
        expect(response.data.type).toBe("text");
      }
    });

    it("returns summary after multiple responses", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      // Submit first response
      const response1 = await submitResponse(sessionId, { scope: "medium" });
      expect(response1.type).toBe("question");

      // Submit second response
      const response2 = await submitResponse(sessionId, { requirements: "Must have login and logout" });
      expect(response2.type).toBe("question");

      // Submit third response - should get summary
      const response3 = await submitResponse(sessionId, { confirm: true });
      expect(response3.type).toBe("complete");

      if (response3.type === "complete") {
        expect(response3.data.title).toBeDefined();
        expect(response3.data.description).toBeDefined();
        expect(response3.data.suggestedSize).toBeDefined();
        expect(response3.data.keyDeliverables).toBeInstanceOf(Array);
      }
    });

    it("throws SessionNotFoundError for invalid session ID", async () => {
      await expect(submitResponse("invalid-session-id", {})).rejects.toThrow(SessionNotFoundError);
    });

    it("throws InvalidSessionStateError when no active question", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      // Complete the session
      await submitResponse(sessionId, { scope: "small" });
      await submitResponse(sessionId, { requirements: "test" });
      await submitResponse(sessionId, { confirm: true });

      // Try to submit another response
      await expect(submitResponse(sessionId, {})).rejects.toThrow(InvalidSessionStateError);
    });

    it("reconstructs agent for a rehydrated session and continues conversation", async () => {
      const store = new MockAiSessionStore();
      const row = buildPlanningRow({
        id: "planning-rehydrated-1",
        status: "awaiting_input",
        conversationHistory: JSON.stringify([
          {
            question: {
              id: "q-1",
              type: "text",
              question: "What should we build?",
              description: "scope",
            },
            response: { "q-1": "Authentication" },
          },
        ]),
        currentQuestion: JSON.stringify({
          id: "q-2",
          type: "text",
          question: "Any constraints?",
          description: "details",
        }),
      });
      store.rows.set(row.id, row);

      setAiSessionStore(store as any);
      expect(rehydrateFromStore(store as any)).toBe(1);

      const resumedAgent = createMockAgent([
        JSON.stringify({
          type: "question",
          data: {
            id: "q-3",
            type: "text",
            question: "Do you need tests?",
            description: "quality",
          },
        }),
      ]);
      const createKbAgentSpy = vi.fn(async () => resumedAgent);
      __setCreateKbAgent(createKbAgentSpy as any);

      const response = await submitResponse(
        row.id,
        { "q-2": "Must run on mobile" },
        TEST_ROOT_DIR,
      );

      expect(response.type).toBe("question");
      if (response.type === "question") {
        expect(response.data.id).toBe("q-3");
      }
      expect(createKbAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: TEST_ROOT_DIR,
          systemPrompt: expect.stringContaining("planning assistant"),
        }),
      );
      expect(resumedAgent.session.prompt).toHaveBeenCalledTimes(2);
      expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain("Previous conversation summary");
      expect(resumedAgent.session.prompt.mock.calls[1]?.[0]).toContain("Any constraints?");
      expect(getSession(row.id)?.agent).toBeDefined();
    });

    it("throws InvalidSessionStateError when resuming without project context", async () => {
      const store = new MockAiSessionStore();
      const row = buildPlanningRow({ id: "planning-rehydrated-2", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);
      rehydrateFromStore(store as any);

      await expect(submitResponse(row.id, { "q-next": "answer" })).rejects.toThrow(
        "cannot be resumed without project context",
      );
    });

    it("captures first generated question thinking in lastGeneratedThinking", async () => {
      setupMockStreamingAgent({
        responses: STANDARD_QUESTION_RESPONSES,
        thinkingPerPrompt: ["First question reasoning"],
      });

      const sessionId = await createSessionWithAgent(getUniqueIp(), initialPlan, TEST_ROOT_DIR);

      await vi.waitFor(() => {
        expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-scope");
      });

      expect(getSession(sessionId)?.lastGeneratedThinking).toBe("First question reasoning");
    });

    it("stores per-turn thinking output in history entries", async () => {
      setupMockStreamingAgent({
        responses: STANDARD_QUESTION_RESPONSES,
        thinkingPerPrompt: ["First question thinking", "Second question thinking"],
      });

      const sessionId = await createSessionWithAgent(getUniqueIp(), initialPlan, TEST_ROOT_DIR);

      await vi.waitFor(() => {
        expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-scope");
      });

      const response = await submitResponse(sessionId, { "q-scope": "medium" }, TEST_ROOT_DIR);
      expect(response.type).toBe("question");

      const session = getSession(sessionId);
      expect(session?.history[0]).toMatchObject({
        question: expect.objectContaining({ id: "q-scope" }),
        response: { "q-scope": "medium" },
        thinkingOutput: "First question thinking",
      });
    });

    it("persists per-turn thinking in conversationHistory JSON", async () => {
      const store = new MockAiSessionStore();
      setAiSessionStore(store as any);
      setupMockStreamingAgent({
        responses: STANDARD_QUESTION_RESPONSES,
        thinkingPerPrompt: ["Persisted first-turn thinking", "Persisted second-turn thinking"],
      });

      const sessionId = await createSessionWithAgent(getUniqueIp(), initialPlan, TEST_ROOT_DIR);

      await vi.waitFor(() => {
        expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-scope");
      });

      await submitResponse(sessionId, { "q-scope": "medium" }, TEST_ROOT_DIR);

      const row = store.get(sessionId);
      expect(row).not.toBeNull();
      const persistedHistory = JSON.parse(row!.conversationHistory) as Array<{
        question: PlanningQuestion;
        response: Record<string, unknown>;
        thinkingOutput?: string;
      }>;

      expect(persistedHistory[0]).toMatchObject({
        question: expect.objectContaining({ id: "q-scope" }),
        response: { "q-scope": "medium" },
        thinkingOutput: "Persisted first-turn thinking",
      });
    });
  });

  describe("retrySession", () => {
    it("rehydrates errored sessions and replays the last user response", async () => {
      const store = new MockAiSessionStore();
      const row = buildPlanningRow({
        id: "planning-error-retry-1",
        status: "error",
        error: "Transient model failure",
        conversationHistory: JSON.stringify([
          {
            question: {
              id: "q-1",
              type: "text",
              question: "What should we build?",
              description: "scope",
            },
            response: { "q-1": "Authentication" },
          },
        ]),
        currentQuestion: JSON.stringify({
          id: "q-2",
          type: "text",
          question: "Any constraints?",
          description: "details",
        }),
      });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const resumedAgent = createMockAgent([
        JSON.stringify({
          type: "question",
          data: {
            id: "q-retry",
            type: "text",
            question: "Any delivery deadline?",
            description: "timing",
          },
        }),
      ]);
      __setCreateKbAgent(async () => resumedAgent);

      await retrySession(row.id, TEST_ROOT_DIR);

      expect(resumedAgent.session.prompt).toHaveBeenCalledTimes(1);
      expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain("What should we build?");
      expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain("Authentication");

      const session = getSession(row.id);
      expect(session?.currentQuestion?.id).toBe("q-retry");
      expect(session?.error).toBeUndefined();
      expect(store.get(row.id)?.status).toBe("awaiting_input");
      expect(store.get(row.id)?.error).toBeNull();
    });

    it("replays the initial plan when no history exists", async () => {
      const store = new MockAiSessionStore();
      const row = buildPlanningRow({
        id: "planning-error-retry-2",
        status: "error",
        error: "First turn failed",
        inputPayload: JSON.stringify({ ip: "127.0.0.9", initialPlan: "Ship notifications" }),
        conversationHistory: "[]",
        currentQuestion: null,
      });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const resumedAgent = createMockAgent([
        JSON.stringify({
          type: "question",
          data: {
            id: "q-first",
            type: "text",
            question: "Who is the target user?",
            description: "audience",
          },
        }),
      ]);
      __setCreateKbAgent(async () => resumedAgent);

      await retrySession(row.id, TEST_ROOT_DIR);

      expect(resumedAgent.session.prompt).toHaveBeenCalledTimes(1);
      expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toBe("Ship notifications");
      expect(store.get(row.id)?.status).toBe("awaiting_input");
    });

    it("throws when retrying a non-error session", async () => {
      const store = new MockAiSessionStore();
      const row = buildPlanningRow({ id: "planning-not-error", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      await expect(retrySession(row.id, TEST_ROOT_DIR)).rejects.toThrow(InvalidSessionStateError);
    });

    it("uses custom prompt from promptOverrides on retry", async () => {
      const store = new MockAiSessionStore();
      const row = buildPlanningRow({
        id: "planning-retry-with-override",
        status: "error",
        error: "Transient failure",
        conversationHistory: JSON.stringify([
          {
            question: { id: "q-1", type: "text", question: "What to build?", description: "scope" },
            response: { "q-1": "Auth" },
          },
        ]),
        currentQuestion: JSON.stringify({
          id: "q-2",
          type: "text",
          question: "Any constraints?",
          description: "details",
        }),
      });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const customPrompt = "Custom retry prompt...";
      const promptOverrides = { "planning-system": customPrompt };

      const resumedAgent = createMockAgent([
        JSON.stringify({
          type: "question",
          data: {
            id: "q-retry",
            type: "text",
            question: "Deadline?",
            description: "timing",
          },
        }),
      ]);
      const createKbAgentSpy = vi.fn(async () => resumedAgent);
      __setCreateKbAgent(createKbAgentSpy as any);

      await retrySession(row.id, TEST_ROOT_DIR, promptOverrides);

      expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
      const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.systemPrompt).toBe(customPrompt);
    });

    it("falls back to default prompt on retry when promptOverrides is undefined", async () => {
      const store = new MockAiSessionStore();
      const row = buildPlanningRow({
        id: "planning-retry-no-override",
        status: "error",
        error: "Transient failure",
        conversationHistory: JSON.stringify([
          {
            question: { id: "q-1", type: "text", question: "What to build?", description: "scope" },
            response: { "q-1": "Auth" },
          },
        ]),
        currentQuestion: JSON.stringify({
          id: "q-2",
          type: "text",
          question: "Any constraints?",
          description: "details",
        }),
      });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const resumedAgent = createMockAgent([
        JSON.stringify({
          type: "question",
          data: {
            id: "q-retry",
            type: "text",
            question: "Deadline?",
            description: "timing",
          },
        }),
      ]);
      const createKbAgentSpy = vi.fn(async () => resumedAgent);
      __setCreateKbAgent(createKbAgentSpy as any);

      await retrySession(row.id, TEST_ROOT_DIR);

      expect(createKbAgentSpy).toHaveBeenCalledTimes(1);
      const callArg = createKbAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.systemPrompt).toContain("planning assistant");
    });
  });

  describe("cancelSession", () => {
    it("removes an active session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      await cancelSession(sessionId);

      // Should not be able to find the session anymore
      expect(getSession(sessionId)).toBeUndefined();
    });

    it("throws SessionNotFoundError for non-existent session", async () => {
      await expect(cancelSession("non-existent-id")).rejects.toThrow(SessionNotFoundError);
    });
  });

  describe("rehydrateFromStore", () => {
    it("rehydrates planning sessions from SQLite rows", () => {
      const store = new MockAiSessionStore();
      const planningRow = buildPlanningRow({ id: "planning-row-1", status: "awaiting_input" });
      const subtaskRow: AiSessionRow = {
        ...buildPlanningRow({ id: "subtask-row-1", status: "awaiting_input" }),
        type: "subtask",
      };
      store.rows.set(planningRow.id, planningRow);
      store.rows.set(subtaskRow.id, subtaskRow);

      const rehydrated = rehydrateFromStore(store as any);

      expect(rehydrated).toBe(1);
      const session = getSession(planningRow.id);
      expect(session).toBeDefined();
      expect(session?.id).toBe(planningRow.id);
      expect(session?.ip).toBe("127.0.0.1");
      expect(session?.currentQuestion?.id).toBe("q-next");
      expect(session?.thinkingOutput).toBe("thinking");
    });

    it("skips corrupted rows and continues rehydrating valid sessions", () => {
      const store = new MockAiSessionStore();
      const goodRow = buildPlanningRow({ id: "planning-good", status: "awaiting_input" });
      const badRow = buildPlanningRow({
        id: "planning-bad",
        status: "awaiting_input",
        conversationHistory: "{bad-json",
      });
      store.rows.set(goodRow.id, goodRow);
      store.rows.set(badRow.id, badRow);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const rehydrated = rehydrateFromStore(store as any);

      expect(rehydrated).toBe(1);
      expect(getSession(goodRow.id)).toBeDefined();
      expect(getSession(badRow.id)).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        `[planning] Failed to rehydrate session ${badRow.id}:`,
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  describe("getSession", () => {
    it("returns session for valid ID", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      const session = getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.id).toBe(sessionId);
      expect(session?.initialPlan).toBe(initialPlan);
      expect(session?.ip).toBe(mockIp);
    });

    it("returns session from memory before SQLite", async () => {
      const store = new MockAiSessionStore();
      const getSpy = vi.spyOn(store, "get");
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      store.rows.set(
        sessionId,
        buildPlanningRow({
          id: sessionId,
          status: "awaiting_input",
          inputPayload: JSON.stringify({ ip: "10.0.0.1", initialPlan: "sqlite-plan" }),
        }),
      );
      setAiSessionStore(store as any);

      const session = getSession(sessionId);

      expect(session?.initialPlan).toBe(initialPlan);
      expect(session?.ip).toBe(mockIp);
      expect(getSpy).not.toHaveBeenCalled();
    });

    it("falls through to SQLite when session is missing in memory", () => {
      const store = new MockAiSessionStore();
      const row = buildPlanningRow({ id: "planning-fallthrough", status: "awaiting_input" });
      store.rows.set(row.id, row);
      setAiSessionStore(store as any);

      const session = getSession(row.id);

      expect(session).toBeDefined();
      expect(session?.id).toBe(row.id);
      expect(session?.initialPlan).toBe("Recovered planning session");
      expect(session?.agent).toBeUndefined();
    });

    it("returns undefined when session exists nowhere", () => {
      const store = new MockAiSessionStore();
      setAiSessionStore(store as any);

      expect(getSession("invalid-id")).toBeUndefined();
    });
  });

  describe("getCurrentQuestion", () => {
    it("returns current question for active session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId, firstQuestion } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      const question = getCurrentQuestion(sessionId);
      expect(question).toEqual(firstQuestion);
    });

    it("returns undefined for completed session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      // Complete the session
      await submitResponse(sessionId, { scope: "small" });
      await submitResponse(sessionId, { requirements: "test" });
      await submitResponse(sessionId, { confirm: true });

      const question = getCurrentQuestion(sessionId);
      expect(question).toBeUndefined();
    });
  });

  describe("getSummary", () => {
    it("returns summary for completed session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      // Complete the session
      await submitResponse(sessionId, { scope: "small" });
      await submitResponse(sessionId, { requirements: "test" });
      const response = await submitResponse(sessionId, { confirm: true });

      if (response.type === "complete") {
        const summary = getSummary(sessionId);
        expect(summary).toEqual(response.data);
      }
    });

    it("returns undefined for incomplete session", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      const summary = getSummary(sessionId);
      expect(summary).toBeUndefined();
    });
  });

  describe("cleanupSession", () => {
    it("removes a session from memory", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      cleanupSession(sessionId);

      expect(getSession(sessionId)).toBeUndefined();
    });
  });

  describe("rate limiting", () => {
    it("checkRateLimit returns true for first request", () => {
      const result = checkRateLimit(getUniqueIp());
      expect(result).toBe(true);
    });

    it("getRateLimitResetTime returns null for unknown IP", () => {
      const resetTime = getRateLimitResetTime("unknown-ip");
      expect(resetTime).toBeNull();
    });

    it("getRateLimitResetTime returns Date for rate limited IP", async () => {
      const mockIp = getUniqueIp();

      // Max out the rate limit
      for (let i = 0; i < 5; i++) {
        await createSession(mockIp, `Plan ${i}`, undefined, TEST_ROOT_DIR);
      }

      const resetTime = getRateLimitResetTime(mockIp);
      expect(resetTime).toBeInstanceOf(Date);
      expect(resetTime!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("session TTL", () => {
    it("uses a 7-day TTL constant", () => {
      expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("does not expire sessions within the old 30-minute window", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const mockIp = getUniqueIp();
        const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

        // Advance beyond the old 30-minute TTL used prior to FN-1146.
        vi.advanceTimersByTime(31 * 60 * 1000);

        expect(getSession(sessionId)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("parseAgentResponse", () => {
    it("parses clean JSON question response", () => {
      const input = '{"type":"question","data":{"id":"q-1","type":"text","question":"What scope?"}}';
      const result = parseAgentResponse(input);
      expect(result.type).toBe("question");
      if (result.type === "question") {
        expect(result.data.id).toBe("q-1");
        expect(result.data.question).toBe("What scope?");
      }
    });

    it("parses clean JSON complete response", () => {
      const input = '{"type":"complete","data":{"title":"My Task","description":"A task","suggestedSize":"M","suggestedDependencies":[],"keyDeliverables":["Code"]}}';
      const result = parseAgentResponse(input);
      expect(result.type).toBe("complete");
      if (result.type === "complete") {
        expect(result.data.title).toBe("My Task");
      }
    });

    it("extracts JSON from markdown code block", () => {
      const input = 'Here is the question:\n```json\n{"type":"question","data":{"id":"q-1","type":"text","question":"What scope?"}}\n```\nLet me know!';
      const result = parseAgentResponse(input);
      expect(result.type).toBe("question");
    });

    it("extracts JSON from markdown code block without language tag", () => {
      const input = 'Some preamble\n```\n{"type":"question","data":{"id":"q-1","type":"text","question":"Hello?"}}\n```\nPostamble';
      const result = parseAgentResponse(input);
      expect(result.type).toBe("question");
    });

    it("extracts JSON surrounded by prose", () => {
      const input = 'I think the best question is:\n{"type":"question","data":{"id":"q-1","type":"text","question":"What is the scope?"}}\nThat should help clarify.';
      const result = parseAgentResponse(input);
      expect(result.type).toBe("question");
    });

    it("repairs truncated JSON with missing closing braces", () => {
      const input = '{"type":"question","data":{"id":"q-1","type":"text","question":"What scope?"';
      // Missing closing "}} at the end — repairJson should add them
      const result = parseAgentResponse(input);
      expect(result.type).toBe("question");
    });

    it("repairs JSON with trailing comma", () => {
      const input = '{"type":"question","data":{"id":"q-1","type":"text","question":"Scope?",},}';
      const result = parseAgentResponse(input);
      expect(result.type).toBe("question");
    });

    it("repairs truncated JSON causing Unexpected end of JSON input", () => {
      // Simulate the exact error described in the issue:
      // "Failed to parse AI response: Unexpected end of JSON input"
      const input = '{"type":"question","data":{"id":"q-1","type":"text","question":"What is the overall';
      // The string value is incomplete (missing closing quote and braces)
      const result = parseAgentResponse(input);
      expect(result.type).toBe("question");
      if (result.type === "question") {
        expect(result.data.id).toBe("q-1");
      }
    });

    it("throws with actionable error for non-JSON text", () => {
      const input = "I'm not sure what to ask about this project.";
      expect(() => parseAgentResponse(input)).toThrow("no valid JSON");
    });

    it("throws with actionable error for invalid structure", () => {
      const input = '{"type":"unknown","data":null}';
      expect(() => parseAgentResponse(input)).toThrow("invalid response structure");
    });

    it("throws with actionable error for missing data field", () => {
      const input = '{"type":"question"}';
      expect(() => parseAgentResponse(input)).toThrow("invalid response structure");
    });

    it("handles JSON embedded inside a longer text with multiple braces", () => {
      const input =
        "Here's my analysis:\n" +
        "Some text with {nested} braces that aren't JSON\n" +
        '{"type":"complete","data":{"title":"Auth System","description":"Build auth","suggestedSize":"M","suggestedDependencies":[],"keyDeliverables":["Login"]}}' +
        "\nThat should work!";

      const result = parseAgentResponse(input);
      expect(result.type).toBe("complete");
    });

    it("picks the largest valid JSON object when multiple exist", () => {
      // Two valid JSON objects — the larger (complete) one should win
      const input =
        '{"type":"question","data":{"id":"q-1","type":"text","question":"Hi?"}} ' +
        'and then {"type":"complete","data":{"title":"Full Task","description":"Do everything","suggestedSize":"L","suggestedDependencies":[],"keyDeliverables":["All the things"]}}';

      const result = parseAgentResponse(input);
      expect(result.type).toBe("complete");
    });
  });

  describe("formatInterviewQA", () => {
    it("returns empty string for empty history", () => {
      expect(formatInterviewQA([])).toBe("");
    });

    it("formats text, single_select, multi_select, and confirm responses", () => {
      const history: Array<{ question: PlanningQuestion; response: unknown }> = [
        {
          question: {
            id: "q-text",
            type: "text",
            question: "What constraints should we consider?",
          },
          response: { "q-text": "Must support offline mode" },
        },
        {
          question: {
            id: "q-single",
            type: "single_select",
            question: "What is the target scope?",
            options: [
              { id: "small", label: "Small" },
              { id: "medium", label: "Medium" },
            ],
          },
          response: { "q-single": "medium" },
        },
        {
          question: {
            id: "q-multi",
            type: "multi_select",
            question: "Which platforms are required?",
            options: [
              { id: "web", label: "Web" },
              { id: "ios", label: "iOS" },
              { id: "android", label: "Android" },
            ],
          },
          response: { "q-multi": ["web", "android"] },
        },
        {
          question: {
            id: "q-confirm",
            type: "confirm",
            question: "Should we include backward compatibility?",
          },
          response: { "q-confirm": true },
        },
      ];

      expect(formatInterviewQA(history)).toBe(
        [
          "## Planning Interview Context",
          "",
          "**Q: What constraints should we consider?**",
          "A: Must support offline mode",
          "",
          "**Q: What is the target scope?**",
          "A: Medium",
          "",
          "**Q: Which platforms are required?**",
          "A: Web, Android",
          "",
          "**Q: Should we include backward compatibility?**",
          "A: Yes",
        ].join("\n")
      );
    });

    it("handles missing options gracefully", () => {
      const history: Array<{ question: PlanningQuestion; response: unknown }> = [
        {
          question: {
            id: "q-single",
            type: "single_select",
            question: "Which tier?",
            options: [{ id: "starter", label: "Starter" }],
          },
          response: { "q-single": "enterprise" },
        },
        {
          question: {
            id: "q-multi",
            type: "multi_select",
            question: "Which integrations?",
            options: [{ id: "slack", label: "Slack" }],
          },
          response: { "q-multi": ["slack", "jira"] },
        },
      ];

      const formatted = formatInterviewQA(history);
      expect(formatted).toContain("A: enterprise");
      expect(formatted).toContain("A: Slack, jira");
    });
  });

  describe("PlanningStreamManager buffering", () => {
    it("stores broadcast events and returns buffered events since id", () => {
      const sessionId = "stream-session-1";
      const received: Array<{ type: string; id?: number }> = [];

      const unsubscribe = planningStreamManager.subscribe(sessionId, (event, eventId) => {
        received.push({ type: event.type, id: eventId });
      });

      const firstId = planningStreamManager.broadcast(sessionId, {
        type: "thinking",
        data: "delta-1",
      });
      const secondId = planningStreamManager.broadcast(sessionId, {
        type: "question",
        data: {
          id: "q-1",
          type: "text",
          question: "Question?",
          description: "desc",
        },
      });

      expect(firstId).toBe(1);
      expect(secondId).toBe(2);
      expect(received).toEqual([
        { type: "thinking", id: 1 },
        { type: "question", id: 2 },
      ]);

      const buffered = planningStreamManager.getBufferedEvents(sessionId, 1);
      expect(buffered).toHaveLength(1);
      expect(buffered[0]).toMatchObject({ id: 2, event: "question" });

      unsubscribe();
    });

    it("broadcast buffers events even with no subscribers", () => {
      const sessionId = "stream-session-2";

      const eventId = planningStreamManager.broadcast(sessionId, {
        type: "complete",
      });

      expect(eventId).toBe(1);
      const buffered = planningStreamManager.getBufferedEvents(sessionId, 0);
      expect(buffered).toHaveLength(1);
      expect(buffered[0]).toMatchObject({ id: 1, event: "complete", data: "{}" });
    });

    it("cleanupSession clears buffered events", () => {
      const sessionId = "stream-session-3";

      planningStreamManager.broadcast(sessionId, {
        type: "thinking",
        data: "delta",
      });
      expect(planningStreamManager.getBufferedEvents(sessionId, 0)).toHaveLength(1);

      planningStreamManager.cleanupSession(sessionId);
      expect(planningStreamManager.getBufferedEvents(sessionId, 0)).toEqual([]);
    });
  });

  describe("generateSubtasksFromPlanning", () => {
    /** Helper: create a session and complete it to get a summary */
    async function createCompletedSession(
      ip: string,
      plan: string
    ): Promise<string> {
      const { sessionId } = await createSession(ip, plan, undefined, TEST_ROOT_DIR);
      // Complete the session by submitting 3 responses
      await submitResponse(sessionId, { "q-scope": "medium" });
      await submitResponse(sessionId, { "q-requirements": "Test requirements" });
      await submitResponse(sessionId, { "q-confirm": true });
      return sessionId;
    }

    it("returns empty array if session not found", () => {
      const result = generateSubtasksFromPlanning("non-existent-session-id");
      expect(result).toEqual([]);
    });

    it("returns empty array if session has no summary (not complete)", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, "Incomplete session", undefined, TEST_ROOT_DIR);

      const result = generateSubtasksFromPlanning(sessionId);
      expect(result).toEqual([]);
    });

    it("generates subtasks from keyDeliverables", async () => {
      const mockIp = getUniqueIp();
      const sessionId = await createCompletedSession(mockIp, "Build auth system");

      const result = generateSubtasksFromPlanning(sessionId);

      // The AI-generated session produces 3 key deliverables:
      // "Implementation", "Tests", "Documentation"
      expect(result.length).toBe(3);

      // First subtask has no dependencies
      expect(result[0]).toEqual({
        id: "subtask-1",
        title: "Implementation",
        description: expect.any(String),
        suggestedSize: "S",
        dependsOn: [],
      });

      // Second subtask depends on first
      expect(result[1]).toEqual({
        id: "subtask-2",
        title: "Tests",
        description: expect.any(String),
        suggestedSize: "M",
        dependsOn: ["subtask-1"],
      });

      // Third subtask depends on second
      expect(result[2]).toEqual({
        id: "subtask-3",
        title: "Documentation",
        description: expect.any(String),
        suggestedSize: "S",
        dependsOn: ["subtask-2"],
      });
    });

    it("appends planning interview context to subtask descriptions when history exists", async () => {
      const mockIp = getUniqueIp();
      const sessionId = await createCompletedSession(mockIp, "Build auth system with context");

      const result = generateSubtasksFromPlanning(sessionId);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]?.description).toContain("## Planning Interview Context");
      expect(result[0]?.description).toContain("**Q: What is the scope of this plan?**");
      expect(result[0]?.description).toContain("A: Medium");
      expect(result[0]?.description).toContain("**Q: What are the key requirements?**");
      expect(result[0]?.description).toContain("A: Test requirements");
      expect(result[0]?.description).toContain("**Q: Are there specific technologies to use?**");
      expect(result[0]?.description).toContain("A: Yes");
    });

    it("keeps subtask descriptions unchanged when history is empty", async () => {
      const mockIp = getUniqueIp();
      const sessionId = await createCompletedSession(mockIp, "Build auth without context");

      const session = getSession(sessionId);
      expect(session?.summary).toBeDefined();
      if (!session?.summary) {
        throw new Error("Expected summary to exist for completed session");
      }

      session.history = [];

      const result = generateSubtasksFromPlanning(sessionId);
      expect(result.length).toBeGreaterThan(0);
      for (const subtask of result) {
        expect(subtask.description).toBe(session.summary.description);
      }
    });

    it("generates fallback subtasks when keyDeliverables is empty", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, "Fallback test", undefined, TEST_ROOT_DIR);

      // Complete the session normally, then manually clear keyDeliverables
      await submitResponse(sessionId, { scope: "small" });
      await submitResponse(sessionId, { requirements: "test" });
      await submitResponse(sessionId, { confirm: true });

      // Get the session and manually clear keyDeliverables to test fallback
      const session = getSession(sessionId);
      expect(session).toBeDefined();
      if (session?.summary) {
        session.summary.keyDeliverables = [];
      }

      const result = generateSubtasksFromPlanning(sessionId);

      expect(result.length).toBe(3);
      expect(result[0]).toEqual({
        id: "subtask-1",
        title: "Define implementation approach",
        description: expect.any(String),
        suggestedSize: "S",
        dependsOn: [],
      });
      expect(result[1]).toEqual({
        id: "subtask-2",
        title: "Implement core changes",
        description: expect.any(String),
        suggestedSize: "M",
        dependsOn: ["subtask-1"],
      });
      expect(result[2]).toEqual({
        id: "subtask-3",
        title: "Verify and polish",
        description: expect.any(String),
        suggestedSize: "S",
        dependsOn: ["subtask-2"],
      });
    });

    it("assigns correct sizes based on deliverable position", async () => {
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, "Multi-deliverable test", undefined, TEST_ROOT_DIR);

      // Complete the session
      await submitResponse(sessionId, { scope: "large" });
      await submitResponse(sessionId, { requirements: "many things" });
      await submitResponse(sessionId, { confirm: true });

      // Modify to have 5 deliverables for size variety
      const session = getSession(sessionId);
      if (session?.summary) {
        session.summary.keyDeliverables = [
          "Setup project structure",
          "Build feature A",
          "Build feature B",
          "Build feature C",
          "Integration tests",
        ];
      }

      const result = generateSubtasksFromPlanning(sessionId);
      expect(result.length).toBe(5);

      // First: S, Middle: M, Last: S
      expect(result[0]?.suggestedSize).toBe("S");
      expect(result[1]?.suggestedSize).toBe("M");
      expect(result[2]?.suggestedSize).toBe("M");
      expect(result[3]?.suggestedSize).toBe("M");
      expect(result[4]?.suggestedSize).toBe("S");
    });

    it("uses sequential dependencies between subtasks", async () => {
      const mockIp = getUniqueIp();
      const sessionId = await createCompletedSession(mockIp, "Dependency test");

      const result = generateSubtasksFromPlanning(sessionId);

      // Each subtask depends on the previous one
      for (let i = 1; i < result.length; i++) {
        expect(result[i]?.dependsOn).toEqual([`subtask-${i}`]);
      }
    });
  });
});

describe("AiSessionStore locking", () => {
  let tmpRoot: string;
  let db: Database;
  let store: AiSessionStore;

  function makeSessionRow(
    id: string,
    status: AiSessionRow["status"] = "awaiting_input",
  ): AiSessionRow {
    const now = new Date().toISOString();
    return {
      id,
      type: "planning",
      status,
      title: `Session ${id}`,
      inputPayload: JSON.stringify({ initialPlan: "Locking test" }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: now,
      updatedAt: now,
      lockedByTab: null,
      lockedAt: null,
    };
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-session-lock-"));
    db = new Database(join(tmpRoot, ".fusion"));
    db.init();
    store = new AiSessionStore(db);
    store.upsert(makeSessionRow("session-lock-1"));
  });

  afterEach(async () => {
    store.stopScheduledCleanup();
    try {
      db.close();
    } catch {
      // no-op
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("acquires lock, detects conflicts, and allows re-entrant acquire", () => {
    const firstAcquire = store.acquireLock("session-lock-1", "tab-a");
    expect(firstAcquire).toEqual({ acquired: true, currentHolder: null });

    const holderAfterAcquire = store.getLockHolder("session-lock-1");
    expect(holderAfterAcquire.tabId).toBe("tab-a");
    expect(holderAfterAcquire.lockedAt).toBeTruthy();

    const conflict = store.acquireLock("session-lock-1", "tab-b");
    expect(conflict).toEqual({ acquired: false, currentHolder: "tab-a" });

    const reentrant = store.acquireLock("session-lock-1", "tab-a");
    expect(reentrant).toEqual({ acquired: true, currentHolder: null });
    expect(store.getLockHolder("session-lock-1").tabId).toBe("tab-a");
  });

  it("releases locks only for the current owner", () => {
    store.acquireLock("session-lock-1", "tab-a");

    const nonOwnerRelease = store.releaseLock("session-lock-1", "tab-b");
    expect(nonOwnerRelease).toBe(false);
    expect(store.getLockHolder("session-lock-1").tabId).toBe("tab-a");

    const ownerRelease = store.releaseLock("session-lock-1", "tab-a");
    expect(ownerRelease).toBe(true);
    expect(store.getLockHolder("session-lock-1")).toEqual({ tabId: null, lockedAt: null });
  });

  it("force acquires lock and clears stale locks", () => {
    store.acquireLock("session-lock-1", "tab-a");

    store.forceAcquireLock("session-lock-1", "tab-b");
    expect(store.getLockHolder("session-lock-1").tabId).toBe("tab-b");

    const staleTimestamp = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    db.prepare("UPDATE ai_sessions SET lockedAt = ? WHERE id = ?").run(staleTimestamp, "session-lock-1");

    const releasedCount = store.releaseStaleLocks();
    expect(releasedCount).toBe(1);
    expect(store.getLockHolder("session-lock-1")).toEqual({ tabId: null, lockedAt: null });
  });

  it("emits ai_session:updated events on lock changes", () => {
    const onUpdated = vi.fn();
    store.on("ai_session:updated", onUpdated);

    store.acquireLock("session-lock-1", "tab-a");
    store.releaseLock("session-lock-1", "tab-a");
    store.forceAcquireLock("session-lock-1", "tab-b");

    const staleTimestamp = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    db.prepare("UPDATE ai_sessions SET lockedAt = ? WHERE id = ?").run(staleTimestamp, "session-lock-1");
    store.releaseStaleLocks();

    expect(onUpdated).toHaveBeenCalled();

    const emittedLocks = onUpdated.mock.calls
      .map(([summary]) => summary.lockedByTab)
      .filter((value) => value !== undefined);

    expect(emittedLocks).toContain("tab-a");
    expect(emittedLocks).toContain("tab-b");
    expect(emittedLocks).toContain(null);
  });

  it("preserves lock state in upsert update events", () => {
    store.acquireLock("session-lock-1", "tab-a");

    const onUpdated = vi.fn();
    store.on("ai_session:updated", onUpdated);

    store.upsert({
      ...makeSessionRow("session-lock-1", "generating"),
      lockedByTab: null,
      lockedAt: null,
    });

    const latestSummary = onUpdated.mock.calls.at(-1)?.[0];
    expect(latestSummary?.lockedByTab).toBe("tab-a");
  });
});

describe("planning routes lock enforcement", () => {
  let tmpRoot: string;
  let taskStore: TaskStore;
  let db: Database;
  let aiSessionStore: AiSessionStore;
  let app: express.Express;

  function makePersistedRow(id: string, type: AiSessionRow["type"] = "planning"): AiSessionRow {
    const now = new Date().toISOString();
    return {
      id,
      type,
      status: "awaiting_input",
      title: `Session ${id}`,
      inputPayload: JSON.stringify({ initialPlan: "Route lock test" }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: now,
      updatedAt: now,
      lockedByTab: null,
      lockedAt: null,
    };
  }

  beforeEach(async () => {
    __resetPlanningState();
    setupMockAgent();

    tmpRoot = mkdtempSync(join(tmpdir(), "kb-planning-lock-routes-"));
    taskStore = new TaskStore(tmpRoot);
    await taskStore.init();

    db = new Database(join(tmpRoot, ".fusion-locks"));
    db.init();
    aiSessionStore = new AiSessionStore(db);
    setAiSessionStore(aiSessionStore as any);

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(taskStore, { aiSessionStore }));
  });

  afterEach(async () => {
    __setCreateKbAgent(undefined as any);
    __resetPlanningState();

    try {
      taskStore.close();
    } catch {
      // no-op
    }

    try {
      db.close();
    } catch {
      // no-op
    }

    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("acquires and releases locks via API routes", async () => {
    aiSessionStore.upsert(makePersistedRow("session-route-lock"));

    const acquire = await request(
      app,
      "POST",
      "/api/ai-sessions/session-route-lock/lock",
      JSON.stringify({ tabId: "tab-a" }),
      { "content-type": "application/json" },
    );
    expect(acquire.status).toBe(200);
    expect(acquire.body).toEqual({ acquired: true });

    const conflictAcquire = await request(
      app,
      "POST",
      "/api/ai-sessions/session-route-lock/lock",
      JSON.stringify({ tabId: "tab-b" }),
      { "content-type": "application/json" },
    );
    expect(conflictAcquire.status).toBe(200);
    expect(conflictAcquire.body).toEqual({ acquired: false, currentHolder: "tab-a" });

    const release = await request(
      app,
      "DELETE",
      "/api/ai-sessions/session-route-lock/lock",
      JSON.stringify({ tabId: "tab-a" }),
      { "content-type": "application/json" },
    );
    expect(release.status).toBe(200);
    expect(release.body).toEqual({ success: true });

    const forceAcquire = await request(
      app,
      "POST",
      "/api/ai-sessions/session-route-lock/lock/force",
      JSON.stringify({ tabId: "tab-c" }),
      { "content-type": "application/json" },
    );
    expect(forceAcquire.status).toBe(200);
    expect(forceAcquire.body).toEqual({ success: true });

    const beaconRelease = await request(
      app,
      "DELETE",
      "/api/ai-sessions/session-route-lock/lock/beacon?tabId=tab-c",
    );
    expect(beaconRelease.status).toBe(200);
  });

  it("returns 409 for planning/respond when another tab holds the lock and allows legacy requests without tabId", async () => {
    const { sessionId } = await createSession(getUniqueIp(), "Route lock planning", taskStore, tmpRoot);
    aiSessionStore.acquireLock(sessionId, "tab-owner");

    const conflictResponse = await request(
      app,
      "POST",
      "/api/planning/respond",
      JSON.stringify({ sessionId, responses: { "q-scope": "small" }, tabId: "tab-other" }),
      { "content-type": "application/json" },
    );

    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body).toEqual({
      error: "Session locked by another tab",
      lockedByTab: "tab-owner",
    });

    const legacyResponse = await request(
      app,
      "POST",
      "/api/planning/respond",
      JSON.stringify({ sessionId, responses: { "q-scope": "small" } }),
      { "content-type": "application/json" },
    );

    expect(legacyResponse.status).toBe(200);
    expect((legacyResponse.body as { type: string }).type).toBe("question");
  });

  it("returns 409 for subtasks/cancel when lock is held by another tab", async () => {
    aiSessionStore.upsert(makePersistedRow("subtask-route-lock", "subtask"));
    aiSessionStore.acquireLock("subtask-route-lock", "tab-a");

    const response = await request(
      app,
      "POST",
      "/api/subtasks/cancel",
      JSON.stringify({ sessionId: "subtask-route-lock", tabId: "tab-b" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "Session locked by another tab",
      lockedByTab: "tab-a",
    });
  });

  it("returns 409 for retry endpoints when lock is held by another tab", async () => {
    aiSessionStore.upsert(makePersistedRow("planning-route-retry", "planning"));
    aiSessionStore.acquireLock("planning-route-retry", "tab-a");

    const planningRetry = await request(
      app,
      "POST",
      "/api/planning/planning-route-retry/retry",
      JSON.stringify({ tabId: "tab-b" }),
      { "content-type": "application/json" },
    );
    expect(planningRetry.status).toBe(409);
    expect(planningRetry.body).toEqual({
      error: "Session locked by another tab",
      lockedByTab: "tab-a",
    });

    aiSessionStore.upsert(makePersistedRow("subtask-route-retry", "subtask"));
    aiSessionStore.acquireLock("subtask-route-retry", "tab-a");

    const subtaskRetry = await request(
      app,
      "POST",
      "/api/subtasks/subtask-route-retry/retry",
      JSON.stringify({ tabId: "tab-b" }),
      { "content-type": "application/json" },
    );
    expect(subtaskRetry.status).toBe(409);
    expect(subtaskRetry.body).toEqual({
      error: "Session locked by another tab",
      lockedByTab: "tab-a",
    });
  });

  it("keeps planning SSE stream read-only and unaffected by locks", async () => {
    const { sessionId } = await createSession(getUniqueIp(), "SSE lock check", taskStore, tmpRoot);
    await submitResponse(sessionId, { "q-scope": "small" }, tmpRoot);
    await submitResponse(sessionId, { "q-requirements": "Need auth" }, tmpRoot);
    await submitResponse(sessionId, { "q-confirm": true }, tmpRoot);

    aiSessionStore.acquireLock(sessionId, "tab-owner");

    const streamResponse = await get(app, `/api/planning/${sessionId}/stream`);
    expect(streamResponse.status).toBe(200);
    expect(String(streamResponse.body)).toContain("event: summary");
    expect(String(streamResponse.body)).toContain("event: complete");
  });
});
