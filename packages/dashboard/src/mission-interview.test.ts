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
  getMissionInterviewSession,
  getMissionInterviewSummary,
  getRateLimitResetTime,
  InvalidSessionStateError,
  missionInterviewStreamManager,
  parseMissionAgentResponse,
  RateLimitError,
  SessionNotFoundError,
  submitMissionInterviewResponse,
} from "./mission-interview.js";

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
