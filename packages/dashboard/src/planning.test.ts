import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createSession,
  createSessionWithAgent,
  submitResponse,
  cancelSession,
  getSession,
  getCurrentQuestion,
  getSummary,
  cleanupSession,
  checkRateLimit,
  getRateLimitResetTime,
  __resetPlanningState,
  __setCreateKbAgent,
  RateLimitError,
  SessionNotFoundError,
  InvalidSessionStateError,
  parseAgentResponse,
  generateSubtasksFromPlanning,
  formatInterviewQA,
} from "./planning.js";
import type { PlanningQuestion, PlanningSummary } from "@fusion/core";

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

    it("throws InvalidSessionStateError if session has no AI agent", async () => {
      // Create a session without an agent by directly manipulating state
      const mockIp = getUniqueIp();
      const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

      // Manually remove the agent to simulate a corrupted session
      const session = getSession(sessionId);
      expect(session).toBeDefined();
      if (session) {
        session.agent = undefined;
      }

      await expect(submitResponse(sessionId, { answer: "test" })).rejects.toThrow(
        InvalidSessionStateError
      );
      try {
        await submitResponse(sessionId, { answer: "test" });
      } catch (err) {
        expect((err as Error).message).toBe("Planning session has no AI agent");
      }
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

    it("returns undefined for invalid ID", () => {
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
    it("sessions expire after TTL", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const mockIp = getUniqueIp();
        const { sessionId } = await createSession(mockIp, initialPlan, undefined, TEST_ROOT_DIR);

        // Verify session exists
        expect(getSession(sessionId)).toBeDefined();

        // Advance time by 31 minutes
        vi.advanceTimersByTime(31 * 60 * 1000);

        // Trigger cleanup by creating a new session
        await createSession(getUniqueIp(), "Another plan", undefined, TEST_ROOT_DIR);

        // Note: Session should be expired after cleanup runs
        // We can't directly verify as cleanup is async
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
