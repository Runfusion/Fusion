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
  createDraftSession,
  startExistingSession,
  submitResponse,
  retrySession,
  cancelSession,
  stopGeneration,
  getSession,
  getCurrentQuestion,
  getSummary,
  cleanupSession,
  planningStreamManager,
  checkRateLimit,
  getRateLimitResetTime,
  __resetPlanningState,
  __setCreateFnAgent,
  __setPlanningDiagnostics,
  __setPlanningNtfyHelpers,
  rehydrateFromStore,
  setAiSessionStore,
  RateLimitError,
  SessionNotFoundError,
  InvalidSessionStateError,
  parseAgentResponse,
  buildDepthPromptSuffix,
  generateSubtasksFromPlanning,
  formatInterviewQA,
  SESSION_TTL_MS,
  GENERATION_TIMEOUT_MS,
} from "../planning.js";
import { createApiRoutes } from "../routes.js";
import { request, get } from "../test-request.js";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";
import { AiSessionStore, type AiSessionRow } from "../ai-session-store.js";

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

async function flushAsyncWork(): Promise<void> {
  await vi.waitFor(() => {
    expect(true).toBe(true);
  });
}

/**
 * Helper: set up a fresh mock agent for the next createSession call.
 * Returns the agent so tests can inspect `.session.prompt` calls.
 */
function setupMockAgent(responses?: string[]) {
  const agent = createMockAgent(responses ?? STANDARD_QUESTION_RESPONSES);
  __setCreateFnAgent(async () => agent);
  return agent;
}

function setupMockStreamingAgent(options?: {
  responses?: string[];
  thinkingPerPrompt?: string[];
}) {
  const responses = options?.responses ?? STANDARD_QUESTION_RESPONSES;
  const thinkingPerPrompt = options?.thinkingPerPrompt ?? [];
  let promptIndex = 0;

  const createFnAgentSpy = vi.fn(async (agentOptions?: { onThinking?: (delta: string) => void }) => {
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

  __setCreateFnAgent(createFnAgentSpy as any);
  return { createFnAgentSpy };
}

function setupMockPlanningNtfyHelpers(options?: { enabledEvent?: boolean; clickUrl?: string }) {
  const sendNtfyNotification = vi.fn(async () => undefined);
  const isNtfyEventEnabled = vi.fn(() => options?.enabledEvent ?? true);
  const buildNtfyClickUrl = vi.fn(() => options?.clickUrl ?? "http://localhost:4040/?project=proj-123");

  __setPlanningNtfyHelpers({
    sendNtfyNotification,
    isNtfyEventEnabled,
    buildNtfyClickUrl,
  });

  return { sendNtfyNotification, isNtfyEventEnabled, buildNtfyClickUrl };
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
    __setCreateFnAgent(undefined as any);
    __setPlanningNtfyHelpers(undefined);
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
      // Create max sessions (1000 per hour)
      for (let i = 0; i < 1000; i++) {
        await createSession(mockIp, `${initialPlan} ${i}`, undefined, TEST_ROOT_DIR);
      }

      // 1001st session should fail
      await expect(createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR)).rejects.toThrow(RateLimitError);
    });

    it("allows new sessions after rate limit window expires", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const mockIp = getUniqueIp();
        // Create max sessions
        for (let i = 0; i < 1000; i++) {
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
      __setCreateFnAgent(async () => {
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
    it("passes planning model override to createFnAgent when provided", async () => {
      const createFnAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateFnAgent(createFnAgentSpy as any);

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        "google",
        "gemini-2.5-pro",
      );

      expect(sessionId).toBeDefined();

      await vi.waitFor(() => {
        expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      expect(createFnAgentSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: "google",
          defaultModelId: "gemini-2.5-pro",
        }),
      );
    });

    it("creates agent without model overrides when none provided", async () => {
      const createFnAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateFnAgent(createFnAgentSpy as any);

      const sessionId = await createSessionWithAgent(getUniqueIp(), "Build auth system", TEST_ROOT_DIR);

      expect(sessionId).toBeDefined();

      await vi.waitFor(() => {
        expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      const callArg = createFnAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.defaultProvider).toBeUndefined();
      expect(callArg?.defaultModelId).toBeUndefined();
    });

    it("uses custom prompt from promptOverrides when provided", async () => {
      const createFnAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateFnAgent(createFnAgentSpy as any);

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
        expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      const callArg = createFnAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.systemPrompt).toBe(customPrompt);
    });

    it("falls back to default prompt when promptOverrides is undefined", async () => {
      const createFnAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateFnAgent(createFnAgentSpy as any);

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
        expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      const callArg = createFnAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.systemPrompt).toContain("planning assistant");
    });

    it("falls back to default prompt when promptOverrides does not contain planning key", async () => {
      const createFnAgentSpy = vi.fn(async () => createMockAgent(STANDARD_QUESTION_RESPONSES));
      __setCreateFnAgent(createFnAgentSpy as any);

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
        expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 10000 });

      const callArg = createFnAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg?.systemPrompt).toContain("planning assistant");
    });

    it("logs error diagnostic when agent initialization fails and preserves error state", async () => {
      // Import the shared helper for diagnostics capture
      const { setDiagnosticsSink, resetDiagnosticsSink } = await import("../ai-session-diagnostics.js");

      let loggedErrors: Array<{ level: string; scope: string; message: string; context: Record<string, unknown> }> = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedErrors.push({ level, scope, message, context });
      });

      try {
        __setCreateFnAgent(async () => {
          throw new Error("Agent creation failed");
        });

        const sessionId = await createSessionWithAgent(
          getUniqueIp(),
          "Build auth system",
          TEST_ROOT_DIR,
        );

        // Wait for the async initialization to complete (errors are logged in initializeAgent's catch block)
        await vi.waitFor(
          () => {
            return loggedErrors.some(
              (e) => e.message === "Agent initialization error for session" && e.context.sessionId === sessionId
            );
          },
          { timeout: 10000 },
        );

        // Verify the error was logged with correct structure
        await vi.waitFor(
          () => {
            const agentError = loggedErrors.find(
              (e) => e.message === "Agent initialization error for session" && e.context.sessionId === sessionId
            );
            expect(agentError).toBeDefined();
            expect(agentError?.level).toBe("error");
            expect(agentError?.scope).toBe("planning");
          },
          { timeout: 5000 },
        );

        const agentError = loggedErrors.find(
          (e) => e.message === "Agent initialization error for session" && e.context.sessionId === sessionId
        );
        expect(agentError?.context.error).toBeDefined();
        expect((agentError?.context.error as { message: string }).message).toBe("Agent creation failed");
        expect(agentError?.context.operation).toBe("initialize-agent");

        // Verify session is in error state
        const session = getSession(sessionId);
        expect(session?.error).toContain("Agent creation failed");
      } finally {
        resetDiagnosticsSink();
      }
    });

    it("persists projectId across planning session state transitions", async () => {
      const store = new MockAiSessionStore();
      setAiSessionStore(store as any);
      setupMockStreamingAgent({ responses: STANDARD_QUESTION_RESPONSES });

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        undefined,
        undefined,
        undefined,
        {
          projectId: "proj-123",
          ntfyConfig: { enabled: false, topic: "planning-topic" },
        },
      );

      await vi.waitFor(() => {
        expect(store.get(sessionId)?.status).toBe("awaiting_input");
      });
      expect(store.get(sessionId)?.projectId).toBe("proj-123");

      await submitResponse(sessionId, { "q-scope": "medium" }, TEST_ROOT_DIR);
      await vi.waitFor(() => {
        expect(store.get(sessionId)?.status).toBe("awaiting_input");
      });
      expect(store.get(sessionId)?.projectId).toBe("proj-123");

      await submitResponse(sessionId, { "q-requirements": "Must support SSO" }, TEST_ROOT_DIR);
      await submitResponse(sessionId, { "q-confirm": true }, TEST_ROOT_DIR);

      await vi.waitFor(() => {
        expect(store.get(sessionId)?.status).toBe("complete");
      });
      expect(store.get(sessionId)?.projectId).toBe("proj-123");
    });

    it("sends planning awaiting-input notifications once per question and allows later distinct questions", async () => {
      const firstQuestion = JSON.stringify({
        type: "question",
        data: { id: "q-1", type: "text", question: "First question?", description: "one" },
      });
      const repeatedQuestion = JSON.stringify({
        type: "question",
        data: { id: "q-1", type: "text", question: "First question?", description: "one" },
      });
      const secondQuestion = JSON.stringify({
        type: "question",
        data: { id: "q-2", type: "text", question: "Second question?", description: "two" },
      });

      setupMockStreamingAgent({ responses: [firstQuestion, repeatedQuestion, secondQuestion] });
      const { sendNtfyNotification, isNtfyEventEnabled, buildNtfyClickUrl } = setupMockPlanningNtfyHelpers({
        enabledEvent: true,
        clickUrl: "http://localhost:4040/?project=proj-123",
      });

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        undefined,
        undefined,
        undefined,
        {
          projectId: "proj-123",
          ntfyConfig: {
            enabled: true,
            topic: "planning-topic",
            dashboardHost: "http://localhost:4040/",
            events: ["planning-awaiting-input"],
          },
        },
      );

      await vi.waitFor(() => {
        expect(sendNtfyNotification).toHaveBeenCalledTimes(1);
      });

      await submitResponse(sessionId, { "q-1": "answer one" }, TEST_ROOT_DIR);
      await flushAsyncWork();
      expect(sendNtfyNotification).toHaveBeenCalledTimes(1);

      await submitResponse(sessionId, { "q-1": "answer two" }, TEST_ROOT_DIR);
      await vi.waitFor(() => {
        expect(sendNtfyNotification).toHaveBeenCalledTimes(2);
      });

      expect(isNtfyEventEnabled).toHaveBeenCalledWith(["planning-awaiting-input"], "planning-awaiting-input");
      expect(buildNtfyClickUrl).toHaveBeenCalledWith({
        dashboardHost: "http://localhost:4040/",
        projectId: "proj-123",
      });
      expect(sendNtfyNotification).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          topic: "planning-topic",
          priority: "high",
          clickUrl: "http://localhost:4040/?project=proj-123",
        }),
      );
    });

    it("detects NotificationService abstraction in engine while using ntfy helpers for planning notifications", async () => {
      const firstQuestion = JSON.stringify({
        type: "question",
        data: { id: "q-1", type: "text", question: "First question?", description: "one" },
      });

      setupMockStreamingAgent({ responses: [firstQuestion] });
      const { sendNtfyNotification, isNtfyEventEnabled, buildNtfyClickUrl } = setupMockPlanningNtfyHelpers({
        enabledEvent: true,
        clickUrl: "http://localhost:4040/?project=proj-123",
      });

      await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        undefined,
        undefined,
        undefined,
        {
          projectId: "proj-123",
          ntfyConfig: {
            enabled: true,
            topic: "planning-topic",
            dashboardHost: "http://localhost:4040/",
            events: ["planning-awaiting-input"],
          },
        },
      );

      await vi.waitFor(() => {
        expect(sendNtfyNotification).toHaveBeenCalledTimes(1);
      });

      expect(sendNtfyNotification).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          topic: "planning-topic",
          priority: "high",
          clickUrl: "http://localhost:4040/?project=proj-123",
        }),
      );

      expect(isNtfyEventEnabled).toHaveBeenCalledWith(["planning-awaiting-input"], "planning-awaiting-input");
      expect(buildNtfyClickUrl).toHaveBeenCalledWith({
        dashboardHost: "http://localhost:4040/",
        projectId: "proj-123",
      });
    });

    it("suppresses planning awaiting-input notifications when event is disabled", async () => {
      setupMockStreamingAgent({ responses: STANDARD_QUESTION_RESPONSES });
      const { sendNtfyNotification } = setupMockPlanningNtfyHelpers({ enabledEvent: false });

      await createSessionWithAgent(
        getUniqueIp(),
        "Build auth system",
        TEST_ROOT_DIR,
        undefined,
        undefined,
        undefined,
        {
          projectId: "proj-123",
          ntfyConfig: {
            enabled: true,
            topic: "planning-topic",
            dashboardHost: "http://localhost:4040/",
            events: ["failed"],
          },
        },
      );

      await flushAsyncWork();
      expect(sendNtfyNotification).not.toHaveBeenCalled();
    });
  });

  describe("draft session helpers", () => {
    it("creates a draft session with draft status", async () => {
      const session = await createDraftSession(
        getUniqueIp(),
        "Draft plan text for the planning modal",
        TEST_ROOT_DIR,
      );

      expect(session.sessionId).toBeDefined();
      expect(session.title).toBe("New planning session");
      expect(getSession(session.sessionId)?.id).toBe(session.sessionId);
    });

    it("starts an existing draft session and moves it into active flow", async () => {
      setupMockStreamingAgent({ responses: STANDARD_QUESTION_RESPONSES });
      const draft = await createDraftSession(
        getUniqueIp(),
        "Draft plan reused by start",
        TEST_ROOT_DIR,
      );

      await startExistingSession(draft.sessionId, TEST_ROOT_DIR);

      await vi.waitFor(() => {
        expect(getSession(draft.sessionId)?.currentQuestion?.id).toBe("q-scope");
      });
    });

    it("throws when starting a missing draft session", async () => {
      await expect(startExistingSession("missing-session", TEST_ROOT_DIR)).rejects.toThrow(
        SessionNotFoundError,
      );
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
      const createFnAgentSpy = vi.fn(async () => resumedAgent);
      __setCreateFnAgent(createFnAgentSpy as any);

      const response = await submitResponse(
        row.id,
        { "q-2": "Must run on mobile" },
        TEST_ROOT_DIR,
      );

      expect(response.type).toBe("question");
      if (response.type === "question") {
        expect(response.data.id).toBe("q-3");
      }
      expect(createFnAgentSpy).toHaveBeenCalledWith(
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
      __setCreateFnAgent(async () => resumedAgent);

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
      __setCreateFnAgent(async () => resumedAgent);

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
      const createFnAgentSpy = vi.fn(async () => resumedAgent);
      __setCreateFnAgent(createFnAgentSpy as any);

      await retrySession(row.id, TEST_ROOT_DIR, promptOverrides);

      expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
      const callArg = createFnAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
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
      const createFnAgentSpy = vi.fn(async () => resumedAgent);
      __setCreateFnAgent(createFnAgentSpy as any);

      await retrySession(row.id, TEST_ROOT_DIR);

      expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
      const callArg = createFnAgentSpy.mock.calls[0]?.[0] as Record<string, unknown>;
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

  describe("generation controls", () => {
    it("returns false when stopping unknown session", () => {
      expect(stopGeneration("missing-session")).toBe(false);
    });

    it("stops in-flight generation and sets user-visible error", async () => {
      let resolvePrompt: (() => void) | undefined;
      const hangingAgent = {
        session: {
          state: { messages: [] as Array<{ role: string; content: string }> },
          prompt: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                resolvePrompt = resolve;
              }),
          ),
          dispose: vi.fn(),
        },
      };
      __setCreateFnAgent(async () => hangingAgent as any);

      const sessionId = await createSessionWithAgent(getUniqueIp(), initialPlan, TEST_ROOT_DIR);
      await vi.waitFor(() => {
        expect(hangingAgent.session.prompt).toHaveBeenCalledTimes(1);
      });

      const stopped = stopGeneration(sessionId);
      expect(stopped).toBe(true);
      expect(hangingAgent.session.dispose).toHaveBeenCalled();

      await flushAsyncWork();
      expect(getSession(sessionId)?.error).toContain("Generation stopped by user");

      resolvePrompt?.();
    });

    it("times out stalled generation and transitions session to error", async () => {
      vi.useFakeTimers();
      try {
        const hangingAgent = {
          session: {
            state: { messages: [] as Array<{ role: string; content: string }> },
            prompt: vi.fn(() => new Promise<void>(() => {})),
            dispose: vi.fn(),
          },
        };
        __setCreateFnAgent(async () => hangingAgent as any);

        const sessionId = await createSessionWithAgent(getUniqueIp(), initialPlan, TEST_ROOT_DIR);

        await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS + 10);
        await flushAsyncWork();

        expect(getSession(sessionId)?.error).toContain("timed out");
      } finally {
        vi.useRealTimers();
      }
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

    it("skips corrupted rows and continues rehydrating valid sessions", async () => {
      // Import the shared helper for diagnostics capture
      const { setDiagnosticsSink, resetDiagnosticsSink } = await import("../ai-session-diagnostics.js");

      const store = new MockAiSessionStore();
      const goodRow = buildPlanningRow({ id: "planning-good", status: "awaiting_input" });
      const badRow = buildPlanningRow({
        id: "planning-bad",
        status: "awaiting_input",
        conversationHistory: "{bad-json",
      });
      store.rows.set(goodRow.id, goodRow);
      store.rows.set(badRow.id, badRow);

      let loggedErrors: Array<{ level: string; scope: string; message: string; context: Record<string, unknown> }> = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedErrors.push({ level, scope, message, context });
      });

      try {
        const rehydrated = rehydrateFromStore(store as any);

        expect(rehydrated).toBe(1);
        expect(getSession(goodRow.id)).toBeDefined();
        expect(getSession(badRow.id)).toBeUndefined();
        expect(loggedErrors).toContainEqual(
          expect.objectContaining({
            level: "error",
            scope: "planning",
            message: "Failed to rehydrate session",
            context: expect.objectContaining({
              sessionId: "planning-bad",
              operation: "rehydrate",
            }),
          })
        );
      } finally {
        resetDiagnosticsSink();
      }
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

  describe("buildDepthPromptSuffix", () => {
    it("returns small depth guidance", () => {
      expect(buildDepthPromptSuffix("small")).toContain("Ask exactly 1-2 focused questions");
    });

    it("returns large depth guidance", () => {
      expect(buildDepthPromptSuffix("large")).toContain("Ask 5-8 thorough questions");
    });

    it("returns custom count guidance", () => {
      expect(buildDepthPromptSuffix(undefined, 5)).toBe(
        "Ask exactly 5 questions. Adjust depth and breadth to fit within that count.",
      );
    });

    it("prioritizes custom count over depth guidance", () => {
      expect(buildDepthPromptSuffix("medium", 7)).toBe(
        "Ask exactly 7 questions. Adjust depth and breadth to fit within that count.",
      );
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

    it("logs error diagnostic when no JSON candidate found before throwing", async () => {
      // Import the shared helper for diagnostics capture
      const { setDiagnosticsSink, resetDiagnosticsSink } = await import("../ai-session-diagnostics.js");

      let loggedErrors: Array<{ level: string; scope: string; message: string; context: Record<string, unknown> }> = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedErrors.push({ level, scope, message, context });
      });

      try {
        const input = "I'm not sure what to ask about this project.";
        expect(() => parseAgentResponse(input)).toThrow("no valid JSON");

        expect(loggedErrors).toContainEqual(
          expect.objectContaining({
            level: "error",
            scope: "planning",
            message: "No JSON candidate found in agent response",
            context: expect.objectContaining({
              inputSnippet: expect.stringContaining("I'm not sure"),
              operation: "parse-json",
            }),
          })
        );
      } finally {
        resetDiagnosticsSink();
      }
    });

    it("logs error diagnostic when repair also fails before throwing", async () => {
      // Import the shared helper for diagnostics capture
      const { setDiagnosticsSink, resetDiagnosticsSink } = await import("../ai-session-diagnostics.js");

      let loggedErrors: Array<{ level: string; scope: string; message: string; context: Record<string, unknown> }> = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedErrors.push({ level, scope, message, context });
      });

      try {
        // Invalid JSON that repair cannot fix (missing quotes around values, unclosed objects)
        const input = '{"type":"question","data":{"id":q-1,"question":"What is this?';
        expect(() => parseAgentResponse(input)).toThrow("Failed to parse AI response");

        expect(loggedErrors).toContainEqual(
          expect.objectContaining({
            level: "error",
            scope: "planning",
            message: "Failed to parse agent response (repair also failed)",
            context: expect.objectContaining({
              inputSnippet: expect.stringContaining('{"type":"question"'),
              operation: "parse-json-repair",
            }),
          })
        );
      } finally {
        resetDiagnosticsSink();
      }
    });

    it("logs error diagnostic for invalid response structure before throwing", async () => {
      // Import the shared helper for diagnostics capture
      const { setDiagnosticsSink, resetDiagnosticsSink } = await import("../ai-session-diagnostics.js");

      let loggedErrors: Array<{ level: string; scope: string; message: string; context: Record<string, unknown> }> = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedErrors.push({ level, scope, message, context });
      });

      try {
        const input = '{"type":"unknown","data":null}';
        expect(() => parseAgentResponse(input)).toThrow("invalid response structure");

        expect(loggedErrors).toContainEqual(
          expect.objectContaining({
            level: "error",
            scope: "planning",
            message: "Invalid response structure from AI",
            context: expect.objectContaining({
              parsedSnippet: expect.stringContaining('"type":"unknown"'),
              operation: "parse-validate",
            }),
          })
        );
      } finally {
        resetDiagnosticsSink();
      }
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

    it("broadcast callback throw logs error but broadcast continues and buffer remains valid", async () => {
      // Import the shared helper for diagnostics capture
      const { setDiagnosticsSink, resetDiagnosticsSink } = await import("../ai-session-diagnostics.js");

      const sessionId = "stream-session-throw";
      let loggedErrors: Array<{ level: string; scope: string; message: string; context: Record<string, unknown> }> = [];
      setDiagnosticsSink((level, scope, message, context) => {
        loggedErrors.push({ level, scope, message, context });
      });

      try {
        let otherCallbackCalled = false;
        const failingCallback = () => {
          throw new Error("Callback failed");
        };
        const workingCallback = () => {
          otherCallbackCalled = true;
        };

        planningStreamManager.subscribe(sessionId, failingCallback);
        planningStreamManager.subscribe(sessionId, workingCallback);

        const eventId = planningStreamManager.broadcast(sessionId, {
          type: "thinking",
          data: "test",
        });

        // Broadcast should continue despite callback failure
        expect(eventId).toBe(1);
        expect(otherCallbackCalled).toBe(true);

        // Buffer should still be valid
        const buffered = planningStreamManager.getBufferedEvents(sessionId, 0);
        expect(buffered).toHaveLength(1);
        expect(buffered[0]).toMatchObject({ id: 1, event: "thinking" });

        // Error should be logged with correct structure
        expect(loggedErrors).toContainEqual(
          expect.objectContaining({
            level: "error",
            scope: "planning",
            message: "Error broadcasting to client",
            context: expect.objectContaining({
              sessionId,
              operation: "broadcast",
            }),
          })
        );
      } finally {
        resetDiagnosticsSink();
      }
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

    it("generates deliverable subtasks with distinct lead guidance plus separate plan context", async () => {
      const mockIp = getUniqueIp();
      const sessionId = await createCompletedSession(mockIp, "Build auth system with context");

      const result = generateSubtasksFromPlanning(sessionId);

      expect(result.length).toBe(3);
      expect(result[0]?.description).toContain('Implement "Implementation" as this subtask\'s primary outcome.');
      expect(result[1]?.description).toContain('Implement "Tests" as this subtask\'s primary outcome.');
      expect(result[2]?.description).toContain('Implement "Documentation" as this subtask\'s primary outcome.');

      expect(result[0]?.description).toContain("## Larger Plan Context");
      expect(result[0]?.description).toContain("## Planning Interview Context");
      expect(result[0]?.description).toContain("**Q: What is the scope of this plan?**");
      expect(result[0]?.description).toContain("A: Medium");
      expect(result[0]?.description).toContain("**Q: What are the key requirements?**");
      expect(result[0]?.description).toContain("A: Test requirements");
      expect(result[0]?.description).toContain("**Q: Are there specific technologies to use?**");
      expect(result[0]?.description).toContain("A: Yes");
    });

    it("keeps larger-plan context section when history is empty", async () => {
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
        expect(subtask.description).toContain("## Larger Plan Context");
        expect(subtask.description).toContain(session.summary.description);
        expect(subtask.description).not.toContain("## Planning Interview Context");
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
      expect(result[0]?.description).toContain("Define the implementation approach for the plan");
      expect(result[1]?.description).toContain("Implement the core code changes described by the plan");
      expect(result[2]?.description).toContain("Verify the implementation end-to-end");
      expect(result[0]?.description).toContain("## Larger Plan Context");
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
    taskStore = new TaskStore(tmpRoot, join(tmpRoot, ".fusion-global-settings"), { inMemoryDb: true });
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
    __setCreateFnAgent(undefined as any);
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

  it("creates a draft planning session via route and persists draft status", async () => {
    const response = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "Build a dashboard settings wizard with guided onboarding steps" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      sessionId: expect.any(String),
      title: "New planning session",
    });
    expect(response.body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const persisted = aiSessionStore.get(response.body.sessionId as string);
    expect(persisted?.status).toBe("draft");
  });

  it("returns 400 for draft creation without non-empty initialPlan", async () => {
    const missing = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(missing.status).toBe(400);

    const empty = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "" }),
      { "content-type": "application/json" },
    );
    expect(empty.status).toBe(400);
  });

  it("returns 429 when draft creation rate limit is exceeded", async () => {
    for (let i = 0; i < 1000; i++) {
      const created = await request(
        app,
        "POST",
        "/api/planning/create-draft",
        JSON.stringify({ initialPlan: `Rate-limited draft ${i}` }),
        { "content-type": "application/json" },
      );
      expect(created.status).toBe(201);
    }

    const rateLimited = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "This draft should hit the rate limit" }),
      { "content-type": "application/json" },
    );

    expect(rateLimited.status).toBe(429);
    expect(String(rateLimited.body?.error ?? "")).toContain("Rate limit exceeded");
  });

  it("reuses existing draft session when starting streaming", async () => {
    const draft = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "Plan draft to be reused by start-streaming" }),
      { "content-type": "application/json" },
    );
    expect(draft.status).toBe(201);
    const draftSessionId = draft.body.sessionId as string;

    const startExisting = await request(
      app,
      "POST",
      "/api/planning/start-streaming",
      JSON.stringify({
        initialPlan: "Plan draft to be reused by start-streaming",
        existingSessionId: draftSessionId,
      }),
      { "content-type": "application/json" },
    );

    expect(startExisting.status).toBe(201);
    expect(startExisting.body).toEqual({ sessionId: draftSessionId });
    expect(aiSessionStore.get(draftSessionId)?.status).toBe("awaiting_input");

    const startNew = await request(
      app,
      "POST",
      "/api/planning/start-streaming",
      JSON.stringify({ initialPlan: "Plan without existing draft" }),
      { "content-type": "application/json" },
    );

    expect(startNew.status).toBe(201);
    expect(startNew.body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(startNew.body.sessionId).not.toBe(draftSessionId);
  });

  it("uses the freshest initialPlan when start-streaming races a pending draft sync", async () => {
    // Simulate the race: draft was created with stale text, the latest debounced
    // PATCH /draft hasn't arrived yet, and the user clicks Start Planning whose
    // request body carries the up-to-date textarea contents. The agent must
    // receive the body's text, not whatever was last persisted to SQLite.
    const draft = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "Stale draft prefix from first keystroke" }),
      { "content-type": "application/json" },
    );
    expect(draft.status).toBe(201);
    const draftSessionId = draft.body.sessionId as string;

    const freshPlan =
      "Stale draft prefix from first keystroke followed by everything the user typed after the debounce window closed";

    const start = await request(
      app,
      "POST",
      "/api/planning/start-streaming",
      JSON.stringify({ initialPlan: freshPlan, existingSessionId: draftSessionId }),
      { "content-type": "application/json" },
    );

    expect(start.status).toBe(201);
    const persisted = aiSessionStore.get(draftSessionId);
    expect(persisted?.inputPayload).toBe(JSON.stringify({ initialPlan: freshPlan }));
  });

  it("re-summarizes the draft title on each call so blur-then-edit doesn't strand stale text", async () => {
    // For short input (≤200 chars) summarizeTitle returns null, so
    // summarizeDraftTitle uses its trimmed-text fallback. That's enough to
    // exercise the regression: the helper used to bail once `title !==
    // DRAFT_PLACEHOLDER_TITLE`, which would lock in the first fallback and
    // ignore the user's subsequent edits even though they were persisted.
    const draft = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "Initial partial draft text" }),
      { "content-type": "application/json" },
    );
    const draftSessionId = draft.body.sessionId as string;

    const firstBlur = await request(
      app,
      "POST",
      `/api/planning/${draftSessionId}/summarize-draft-title`,
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(firstBlur.status).toBe(200);
    expect(firstBlur.body).toEqual({ title: "Initial partial draft text" });
    expect(aiSessionStore.get(draftSessionId)?.title).toBe("Initial partial draft text");

    await request(
      app,
      "PATCH",
      `/api/ai-sessions/${draftSessionId}/draft`,
      JSON.stringify({ initialPlan: "Final draft text after the user kept typing" }),
      { "content-type": "application/json" },
    );

    const secondBlur = await request(
      app,
      "POST",
      `/api/planning/${draftSessionId}/summarize-draft-title`,
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(secondBlur.status).toBe(200);
    expect(secondBlur.body).toEqual({ title: "Final draft text after the user kept typing" });
    expect(aiSessionStore.get(draftSessionId)?.title).toBe(
      "Final draft text after the user kept typing",
    );
  });

  it("persists the model override on draft create and round-trips it through inputPayload", async () => {
    const draft = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({
        initialPlan: "Plan that needs a specific model",
        planningModelProvider: "anthropic",
        planningModelId: "claude-opus-4-7",
      }),
      { "content-type": "application/json" },
    );
    expect(draft.status).toBe(201);
    const draftSessionId = draft.body.sessionId as string;

    // The draft row's inputPayload must carry the model override so the
    // frontend reopen path can restore it into modal state and so a later
    // summarize call uses it instead of falling back to project defaults.
    const persisted = aiSessionStore.get(draftSessionId);
    const payload = JSON.parse(persisted?.inputPayload ?? "{}");
    expect(payload.modelProvider).toBe("anthropic");
    expect(payload.modelId).toBe("claude-opus-4-7");

    // PATCH /draft can also update the override (user switched models mid-edit).
    await request(
      app,
      "PATCH",
      `/api/ai-sessions/${draftSessionId}/draft`,
      JSON.stringify({
        initialPlan: "Plan that needs a specific model",
        modelProvider: "openai",
        modelId: "gpt-5",
      }),
      { "content-type": "application/json" },
    );
    const updatedPayload = JSON.parse(aiSessionStore.get(draftSessionId)?.inputPayload ?? "{}");
    expect(updatedPayload.modelProvider).toBe("openai");
    expect(updatedPayload.modelId).toBe("gpt-5");

    // A half-set override on PATCH clears the persisted override entirely
    // rather than landing in a half-configured state the start path rejects.
    await request(
      app,
      "PATCH",
      `/api/ai-sessions/${draftSessionId}/draft`,
      JSON.stringify({
        initialPlan: "Plan that needs a specific model",
        modelProvider: "openai",
      }),
      { "content-type": "application/json" },
    );
    const clearedPayload = JSON.parse(aiSessionStore.get(draftSessionId)?.inputPayload ?? "{}");
    expect(clearedPayload.modelProvider).toBeUndefined();
    expect(clearedPayload.modelId).toBeUndefined();
  });

  it("skips re-summarize on start when blur/close already summarized the same final text", async () => {
    // Sequence the bug guards:
    //  1. Create a draft.
    //  2. Blur → summarizeDraftTitle runs against the persisted text and
    //     records `summarizedFor` so the start path knows the title is
    //     up-to-date for that exact text.
    //  3. Click Start with the same text → startExistingSession should
    //     skip its own summarize and leave the title from step 2 intact.
    const draft = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "Stable plan body the user already finished writing" }),
      { "content-type": "application/json" },
    );
    const draftSessionId = draft.body.sessionId as string;

    const blur = await request(
      app,
      "POST",
      `/api/planning/${draftSessionId}/summarize-draft-title`,
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(blur.status).toBe(200);
    const titleAfterBlur = blur.body.title as string;
    expect(titleAfterBlur).not.toBe("New planning session");

    setupMockStreamingAgent({ responses: STANDARD_QUESTION_RESPONSES });
    const start = await request(
      app,
      "POST",
      "/api/planning/start-streaming",
      JSON.stringify({
        initialPlan: "Stable plan body the user already finished writing",
        existingSessionId: draftSessionId,
      }),
      { "content-type": "application/json" },
    );
    expect(start.status).toBe(201);

    // Title is preserved exactly — no overwrite from a second summarize call.
    expect(aiSessionStore.get(draftSessionId)?.title).toBe(titleAfterBlur);

    // And the persisted summarizedFor still equals the final initialPlan
    // so a future restart wouldn't re-summarize either.
    const payload = JSON.parse(aiSessionStore.get(draftSessionId)?.inputPayload ?? "{}");
    expect(payload.summarizedFor).toBe("Stable plan body the user already finished writing");
  });

  it("re-summarizes on start when the user typed more after the last blur", async () => {
    // Counterpart to the dedup test: if the persisted text is now different
    // from what was last summarized, the start path must re-summarize so
    // the sidebar doesn't show a stale title once the session is running.
    const draft = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "Initial plan body before the late edits" }),
      { "content-type": "application/json" },
    );
    const draftSessionId = draft.body.sessionId as string;

    await request(
      app,
      "POST",
      `/api/planning/${draftSessionId}/summarize-draft-title`,
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    const blurredPayload = JSON.parse(aiSessionStore.get(draftSessionId)?.inputPayload ?? "{}");
    expect(blurredPayload.summarizedFor).toBe("Initial plan body before the late edits");

    // User keeps typing — sync the new text via PATCH /draft. This must
    // preserve summarizedFor only if it still equals the new initialPlan;
    // since the text just changed, summarizedFor becomes stale.
    await request(
      app,
      "PATCH",
      `/api/ai-sessions/${draftSessionId}/draft`,
      JSON.stringify({ initialPlan: "Initial plan body before the late edits and now with extra detail" }),
      { "content-type": "application/json" },
    );
    const updatedPayload = JSON.parse(aiSessionStore.get(draftSessionId)?.inputPayload ?? "{}");
    expect(updatedPayload.summarizedFor).toBeUndefined();

    setupMockStreamingAgent({ responses: STANDARD_QUESTION_RESPONSES });
    await request(
      app,
      "POST",
      "/api/planning/start-streaming",
      JSON.stringify({
        initialPlan: "Initial plan body before the late edits and now with extra detail",
        existingSessionId: draftSessionId,
      }),
      { "content-type": "application/json" },
    );

    // Start path summarized again (or fell back to truncation) against the
    // new text. summarizeTitle returns null for short text so the fallback
    // is the first 60 chars of the trimmed plan; the key assertion is that
    // the title now reflects the post-edit text, not the stale prefix it
    // had after the original blur.
    const finalTitle = aiSessionStore.get(draftSessionId)?.title ?? "";
    const expectedFallback =
      "Initial plan body before the late edits and now with extra detail".slice(0, 60).trim();
    expect(finalTitle).toBe(expectedFallback);
    expect(finalTitle).not.toBe("Initial plan body before the late edits");
  });

  it("re-summarizes on start when the model changed since the last summarize, even if text is identical", async () => {
    // Defeats a subtle dedup loophole: blur produces a title under model A;
    // the user switches to model B without editing text; clicking Start
    // would otherwise reuse A's summary. updateDraft must invalidate
    // summarizedFor on a model change so the start path summarizes again
    // under model B.
    const draft = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({
        initialPlan: "Plan body that does not change between blur and start",
        planningModelProvider: "anthropic",
        planningModelId: "claude-opus-4-7",
      }),
      { "content-type": "application/json" },
    );
    const draftSessionId = draft.body.sessionId as string;

    const blur = await request(
      app,
      "POST",
      `/api/planning/${draftSessionId}/summarize-draft-title`,
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    expect(blur.status).toBe(200);
    const titleAfterBlur = blur.body.title as string;
    const blurredPayload = JSON.parse(aiSessionStore.get(draftSessionId)?.inputPayload ?? "{}");
    expect(blurredPayload.summarizedFor).toBe("Plan body that does not change between blur and start");
    expect(blurredPayload.modelProvider).toBe("anthropic");

    // User switches model without editing text — the modal calls
    // updatePlanningSessionDraft with the new override.
    await request(
      app,
      "PATCH",
      `/api/ai-sessions/${draftSessionId}/draft`,
      JSON.stringify({
        initialPlan: "Plan body that does not change between blur and start",
        modelProvider: "openai",
        modelId: "gpt-5",
      }),
      { "content-type": "application/json" },
    );

    // summarizedFor must be cleared even though the text is identical —
    // the prior summary was produced by a different model.
    const switchedPayload = JSON.parse(aiSessionStore.get(draftSessionId)?.inputPayload ?? "{}");
    expect(switchedPayload.modelProvider).toBe("openai");
    expect(switchedPayload.modelId).toBe("gpt-5");
    expect(switchedPayload.summarizedFor).toBeUndefined();

    // The dropped summarizedFor above is the load-bearing assertion: it
    // means startExistingSession's skip condition
    // (persistedSummarizedFor === trimmed) evaluates to false, so the
    // re-summarize path runs under the new model on Start. Title equality
    // can't distinguish "skipped" from "re-summarized to the same fallback"
    // for short text, so we verify the upstream signal that drives the
    // decision rather than asserting on the resulting title string.
    void titleAfterBlur;
  });

  it("starts a draft that survived a backend restart by lazily rebuilding from SQLite", async () => {
    // Recreate the post-restart state: draft persisted in SQLite but the
    // in-memory sessions map is empty (rehydrateFromStore skips drafts since
    // listRecoverable only returns generating/awaiting_input rows).
    const draft = await request(
      app,
      "POST",
      "/api/planning/create-draft",
      JSON.stringify({ initialPlan: "Plan that should outlive a server restart" }),
      { "content-type": "application/json" },
    );
    expect(draft.status).toBe(201);
    const draftSessionId = draft.body.sessionId as string;

    // Wipe in-memory state to simulate a backend restart, then re-wire the
    // SQLite-backed store. The SQLite draft row survives; the in-memory
    // sessions map is empty because rehydrateFromStore intentionally skips
    // drafts (it only recovers in-flight generating/awaiting_input rows).
    __resetPlanningState();
    setAiSessionStore(aiSessionStore as any);
    expect(aiSessionStore.get(draftSessionId)?.status).toBe("draft");

    const start = await request(
      app,
      "POST",
      "/api/planning/start-streaming",
      JSON.stringify({
        initialPlan: "Plan that should outlive a server restart",
        existingSessionId: draftSessionId,
      }),
      { "content-type": "application/json" },
    );

    expect(start.status).toBe(201);
    expect(start.body).toEqual({ sessionId: draftSessionId });
    expect(getSession(draftSessionId)?.id).toBe(draftSessionId);
    expect(aiSessionStore.get(draftSessionId)?.status).toBe("awaiting_input");
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

// ── Thinking-Block Response Extraction Tests (FN-3300) ─────────────────────

describe("FN-3300: thinking-block response extraction", () => {
  /**
   * Creates a mock agent that returns array content blocks (thinking + text).
   * This simulates Claude-style extended thinking responses.
   */
  function createMockAgentWithBlocks(
    responses: Array<
      | string
      | Array<{ type: string; text?: string; thinking?: string }>
    >,
  ) {
    const messages: Array<{
      role: string;
      content:
        | string
        | Array<{ type: string; text?: string; thinking?: string }>;
    }> = [];
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

  /**
   * Creates a mock streaming agent with array content blocks and callbacks.
   */
  function setupMockStreamingAgentWithBlocks(options: {
    contentBlocks: Array<
      | string
      | Array<{ type: string; text?: string; thinking?: string }>
    >;
    thinkingOutputPerPrompt?: string[];
  }) {
    const contentBlocks = options.contentBlocks;
    const thinkingOutputPerPrompt = options.thinkingOutputPerPrompt ?? [];
    let promptIndex = 0;

    const createFnAgentSpy = vi.fn(
      async (agentOptions?: {
        onThinking?: (delta: string) => void;
        onText?: (delta: string) => void;
      }) => {
        const messages: Array<{
          role: string;
          content:
            | string
            | Array<{ type: string; text?: string; thinking?: string }>;
        }> = [];

        return {
          session: {
            state: { messages },
            prompt: vi.fn(async (message: string) => {
              messages.push({ role: "user", content: message });
              const thinking = thinkingOutputPerPrompt[promptIndex];
              if (thinking) {
                agentOptions?.onText?.(thinking);
              }
              const response = contentBlocks[promptIndex] ?? contentBlocks[contentBlocks.length - 1];
              messages.push({ role: "assistant", content: response });
              promptIndex += 1;
            }),
            dispose: vi.fn(),
          },
        };
      },
    );

    __setCreateFnAgent(createFnAgentSpy as any);
    return { createFnAgentSpy };
  }

  const questionJson = JSON.stringify({
    type: "question",
    data: {
      id: "q-scope",
      type: "single_select",
      question: "What is the scope?",
      description: "Describe the scope.",
      options: [
        { id: "small", label: "Small", description: "Quick" },
        { id: "medium", label: "Medium", description: "Standard" },
        { id: "large", label: "Large", description: "Complex" },
      ],
    },
  });

  beforeEach(() => {
    __resetPlanningState();
  });

  describe("continueAgentConversation (streaming path)", () => {
    it("falls back to thinkingOutput when message content has only thinking blocks", async () => {
      // The streaming agent accumulates text via onText callback into thinkingOutput.
      // When the message content array has only thinking-type blocks, the
      // text blocks filter yields empty string. The fix ensures we fall back
      // to the accumulated thinkingOutput instead of overwriting with "".
      setupMockStreamingAgentWithBlocks({
        contentBlocks: [
          // First prompt: only thinking blocks in message content
          [{ type: "thinking", thinking: "Let me think about this..." }],
          // Retry prompt: valid text response
          questionJson,
        ],
        // The actual JSON was accumulated via onText callback during streaming
        thinkingOutputPerPrompt: [questionJson, questionJson],
      });

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Test plan",
        TEST_ROOT_DIR,
      );

      await vi.waitFor(() => {
        expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-scope");
      });

      // Submit response to trigger continueAgentConversation
      const result = await submitResponse(sessionId, { "q-scope": "medium" }, TEST_ROOT_DIR);
      expect(result.type).toBe("question");
      if (result.type === "question") {
        expect(result.data.id).toBe("q-scope");
      }
    });

    it("prefers text blocks over thinkingOutput when both are present", async () => {
      const differentJson = JSON.stringify({
        type: "question",
        data: {
          id: "q-from-text-block",
          type: "text",
          question: "What do you need?",
          description: "Describe.",
        },
      });

      setupMockStreamingAgentWithBlocks({
        contentBlocks: [
          // Message has both thinking AND text blocks
          [
            { type: "thinking", thinking: "Thinking about the response..." },
            { type: "text", text: differentJson },
          ],
        ],
        // thinkingOutput has something different — should NOT be used
        thinkingOutputPerPrompt: ["old-thinking-output"],
      });

      const sessionId = await createSessionWithAgent(
        getUniqueIp(),
        "Test plan",
        TEST_ROOT_DIR,
      );

      await vi.waitFor(() => {
        expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-from-text-block");
      });

      const result = await submitResponse(sessionId, { "q-from-text-block": "value" }, TEST_ROOT_DIR);
      expect(result.type).toBe("question");
      if (result.type === "question") {
        expect(result.data.id).toBe("q-from-text-block");
      }
    });
  });

  describe("getFirstQuestionFromAgent (non-streaming path)", () => {
    it("extracts thinking block content when no text blocks are present", async () => {
      // Non-streaming path: createSession uses createMockAgent which returns
      // array content blocks. When only thinking blocks exist, extract their text.
      const agent = createMockAgentWithBlocks([
        // Only thinking blocks — the JSON is inside the thinking text
        [{ type: "thinking", thinking: questionJson }],
      ]);
      __setCreateFnAgent(async () => agent);

      const result = await createSession(
        getUniqueIp(),
        "Test plan",
        undefined,
        TEST_ROOT_DIR,
      );

      expect(result.firstQuestion).toBeDefined();
      expect(result.firstQuestion.id).toBe("q-scope");
    });

    it("prefers text blocks over thinking blocks when both present", async () => {
      const textBlockJson = JSON.stringify({
        type: "question",
        data: {
          id: "q-from-text",
          type: "text",
          question: "Text block question?",
          description: "From text block.",
        },
      });

      const agent = createMockAgentWithBlocks([
        [
          { type: "thinking", thinking: questionJson },
          { type: "text", text: textBlockJson },
        ],
      ]);
      __setCreateFnAgent(async () => agent);

      const result = await createSession(
        getUniqueIp(),
        "Test plan",
        undefined,
        TEST_ROOT_DIR,
      );

      expect(result.firstQuestion).toBeDefined();
      expect(result.firstQuestion.id).toBe("q-from-text");
    });
  });

  describe("diagnostics logging for empty response text", () => {
    it("logs warning when response text is empty after extraction", async () => {
      const { setDiagnosticsSink, resetDiagnosticsSink: resetSink } = await import(
        "../ai-session-diagnostics.js"
      );

      const warnings: Array<{
        level: string;
        scope: string;
        message: string;
        context: Record<string, unknown>;
      }> = [];
      setDiagnosticsSink((level, scope, message, context) => {
        warnings.push({ level, scope, message, context });
      });

      try {
        // Agent returns content array with only thinking blocks, and no
        // thinking text in them either — truly empty thinking blocks
        const agent = createMockAgentWithBlocks([
          [{ type: "thinking", thinking: "" }],
        ]);
        __setCreateFnAgent(async () => agent);

        await expect(
          createSession(getUniqueIp(), "Test plan", undefined, TEST_ROOT_DIR),
        ).rejects.toThrow("Failed to get first question from AI");

        // Should have logged a warning about empty response text
        const extractionWarning = warnings.find(
          (w) =>
            w.message === "Response text is empty or very short before parse" &&
            w.context.operation === "response-extraction",
        );
        expect(extractionWarning).toBeDefined();
        expect(extractionWarning!.context.contentBlockTypes).toEqual([
          "thinking",
        ]);
      } finally {
        resetSink();
      }
    });
  });
});
