// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateFnAgent } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  createFnAgent: mockCreateFnAgent,
}));

import {
  __resetMilestoneSliceInterviewState,
  cancelTargetInterviewSession,
  checkRateLimit,
  cleanupTargetInterviewSession,
  createTargetInterviewSession,
  retryTargetInterviewSession,
  getTargetInterviewSession,
  getTargetInterviewSummary,
  getRateLimitResetTime,
  InvalidSessionStateError,
  TargetInvalidSessionStateError,
  milestoneSliceInterviewStreamManager,
  parseTargetInterviewResponse,
  rehydrateFromStore,
  setAiSessionStore,
  RateLimitError,
  TargetSessionNotFoundError,
  submitTargetInterviewResponse,
  applyTargetInterview,
  skipTargetInterview,
  MILESTONE_INTERVIEW_SYSTEM_PROMPT,
  SLICE_INTERVIEW_SYSTEM_PROMPT,
  stopMilestoneSliceInterviewGeneration,
  GENERATION_TIMEOUT_MS,
  type MilestoneInterviewSummary,
  type SliceInterviewSummary,
} from "../milestone-slice-interview.js";
import { EventEmitter } from "node:events";
import type { AiSessionRow } from "../ai-session-store.js";

function createQuestionJson(id = "q-1"): string {
  return JSON.stringify({
    type: "question",
    data: {
      id,
      type: "text",
      question: "What should we refine first?",
      description: "Initial scope",
    },
  });
}

function createMilestoneCompleteJson(): string {
  return JSON.stringify({
    type: "complete",
    data: {
      title: "Refined Milestone",
      description: "Detailed milestone description",
      planningNotes: "Key planning decisions",
      verification: "How to verify completion",
      slices: [
        {
          title: "Slice 1",
          description: "First slice",
          verification: "Slice 1 verification",
        },
      ],
    },
  });
}

function createSliceCompleteJson(): string {
  return JSON.stringify({
    type: "complete",
    data: {
      title: "Refined Slice",
      description: "Detailed slice description",
      planningNotes: "Key planning decisions",
      verification: "How to verify completion",
      features: [
        {
          title: "Feature 1",
          description: "First feature",
          acceptanceCriteria: "AC-1",
        },
      ],
    },
  });
}

function createMockAgent(responses: string[]) {
  const queue = [...responses];
  const messages: Array<{ role: string; content: string }> = [];
  let thinkingCb: ((delta: string) => void) | undefined;
  let textCb: ((delta: string) => void) | undefined;

  const agent: any = {
    session: {
      state: { messages },
      prompt: vi.fn(async () => {
        const response = queue.shift() ?? createQuestionJson("q-fallback");
        // Trigger the callbacks with the response (simulates thinking output)
        thinkingCb?.(response);
        textCb?.(response);
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };

  // Setup mock to capture callbacks
  mockCreateFnAgent.mockImplementation(async (options: any) => {
    thinkingCb = options?.onThinking;
    textCb = options?.onText;
    return agent;
  });

  return agent;
}

async function waitForCurrentQuestion(sessionId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (getTargetInterviewSession(sessionId)?.currentQuestion) {
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

function buildSessionRow(
  overrides: Partial<AiSessionRow> & Pick<AiSessionRow, "id" | "status">,
): AiSessionRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    type: overrides.type ?? "milestone_interview",
    status: overrides.status,
    title: overrides.title ?? "Interview planning",
    inputPayload:
      overrides.inputPayload ??
      JSON.stringify({
        ip: "127.0.0.1",
        targetType: "milestone",
        targetId: "ms-123",
        targetTitle: "Milestone planning",
      }),
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
          response: { "q-1": "Refine this milestone" },
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

describe("milestone-slice-interview module", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    __resetMilestoneSliceInterviewState();
    // Reset cached createFnAgent to force re-import with mock
    const mod = await import("../milestone-slice-interview.js") as any;
    mod.__resetEngine?.();
    mockCreateFnAgent.mockImplementation(async () => createMockAgent([createQuestionJson()]));
  });

  describe("session lifecycle", () => {
    it("creates, retrieves, and cleans up a milestone session", async () => {
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "milestone",
        "ms-123",
        "Launch Platform",
        "Mission: Launch Platform v2",
        "/tmp/project"
      );

      const session = getTargetInterviewSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.targetType).toBe("milestone");
      expect(session?.targetId).toBe("ms-123");
      expect(session?.targetTitle).toBe("Launch Platform");
      expect(session?.missionContext).toBe("Mission: Launch Platform v2");

      cleanupTargetInterviewSession(sessionId);
      expect(getTargetInterviewSession(sessionId)).toBeUndefined();
    });

    it("creates, retrieves, and cleans up a slice session", async () => {
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "slice",
        "sl-456",
        "Auth System",
        "Mission: Launch v2 | Milestone: Foundation",
        "/tmp/project"
      );

      const session = getTargetInterviewSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.targetType).toBe("slice");
      expect(session?.targetId).toBe("sl-456");
      expect(session?.targetTitle).toBe("Auth System");
      expect(session?.missionContext).toBe("Mission: Launch v2 | Milestone: Foundation");

      cleanupTargetInterviewSession(sessionId);
      expect(getTargetInterviewSession(sessionId)).toBeUndefined();
    });

    it("cancels a session and throws when canceling missing session", async () => {
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "milestone",
        "ms-789",
        "Cancel mission",
        undefined,
        "/tmp/project"
      );
      await waitForCurrentQuestion(sessionId);

      await cancelTargetInterviewSession(sessionId);
      expect(getTargetInterviewSession(sessionId)).toBeUndefined();

      await expect(cancelTargetInterviewSession("non-existent")).rejects.toThrow(TargetSessionNotFoundError);
    });
  });

  describe("rate limiting", () => {
    it("enforces max sessions per IP per hour", () => {
      // Simulate 5 requests
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit("192.168.1.1")).toBe(true);
      }
      // 6th should be blocked
      expect(checkRateLimit("192.168.1.1")).toBe(false);
    });

    it("allows different IPs", () => {
      expect(checkRateLimit("192.168.1.1")).toBe(true);
      expect(checkRateLimit("192.168.1.2")).toBe(true);
      expect(checkRateLimit("192.168.1.3")).toBe(true);
    });
  });

  describe("rehydration", () => {
    it("rehydrates milestone_interview sessions from recoverable rows", () => {
      const store = new MockAiSessionStore();
      const row = buildSessionRow({
        id: "rehydrated-ms",
        status: "awaiting_input",
        type: "milestone_interview",
      });
      store.rows.set(row.id, row);

      const count = rehydrateFromStore(store);
      expect(count).toBe(1);
      expect(getTargetInterviewSession("rehydrated-ms")).toBeDefined();
    });

    it("rehydrates slice_interview sessions from recoverable rows", () => {
      const store = new MockAiSessionStore();
      const row = buildSessionRow({
        id: "rehydrated-sl",
        status: "awaiting_input",
        type: "slice_interview",
        inputPayload: JSON.stringify({
          ip: "127.0.0.1",
          targetType: "slice",
          targetId: "sl-123",
          targetTitle: "Slice planning",
        }),
      });
      store.rows.set(row.id, row);

      const count = rehydrateFromStore(store);
      expect(count).toBe(1);
      const session = getTargetInterviewSession("rehydrated-sl");
      expect(session?.targetType).toBe("slice");
    });

    it("skips corrupted rows and continues with valid rows", () => {
      const store = new MockAiSessionStore();
      store.rows.set("valid-row", buildSessionRow({
        id: "valid-row",
        status: "awaiting_input",
        type: "milestone_interview",
      }));
      // Add a corrupted row
      store.rows.set("corrupted-row", {
        ...buildSessionRow({ id: "corrupted-row", status: "awaiting_input" }),
        conversationHistory: "invalid json {{{",
      } as AiSessionRow);

      const count = rehydrateFromStore(store);
      expect(count).toBe(1);
      expect(getTargetInterviewSession("valid-row")).toBeDefined();
      expect(getTargetInterviewSession("corrupted-row")).toBeUndefined();
    });

    it("falls through to SQLite when in-memory session is missing", () => {
      const sessionId = "sqlite-fallback";
      const store = new MockAiSessionStore();
      const row = buildSessionRow({
        id: sessionId,
        status: "awaiting_input",
        type: "slice_interview",
        inputPayload: JSON.stringify({
          ip: "127.0.0.1",
          targetType: "slice",
          targetId: "sl-456",
          targetTitle: "SQLite fallback",
        }),
      });
      store.rows.set(sessionId, row);

      // No in-memory session yet
      expect(getTargetInterviewSession(sessionId)).toBeUndefined();

      // Should fall through to SQLite
      setAiSessionStore(store);
      const session = getTargetInterviewSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.targetId).toBe("sl-456");
    });
  });

  describe("submitTargetInterviewResponse", () => {
    // Note: Full end-to-end tests with AI completion are complex due to async agent mocking.
    // These tests verify the response submission path.

    it("throws error for unknown session", async () => {
      await expect(
        submitTargetInterviewResponse("unknown-session", { "q-1": "test" }, "/tmp")
      ).rejects.toThrow(TargetSessionNotFoundError);
    });

    it("throws error when no active question", async () => {
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "milestone",
        "ms-no-q",
        "Test",
        undefined,
        "/tmp/project"
      );
      await waitForCurrentQuestion(sessionId);

      // Manually clear the question to simulate state
      const session = getTargetInterviewSession(sessionId);
      if (session) {
        session.currentQuestion = undefined;
      }

      await expect(
        submitTargetInterviewResponse(sessionId, { "q-1": "test" }, "/tmp")
      ).rejects.toThrow(InvalidSessionStateError);
    });
  });

  describe("retryTargetInterviewSession", () => {
    it("replays initial prompt when history is empty", async () => {
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "milestone",
        "ms-retry",
        "Retry Test",
        undefined,
        "/tmp/project"
      );

      // Mark session as errored
      const store = new MockAiSessionStore();
      store.rows.set(sessionId, buildSessionRow({
        id: sessionId,
        status: "error",
        type: "milestone_interview",
        conversationHistory: "[]",
        currentQuestion: null,
        error: "Previous error",
      }));
      setAiSessionStore(store);

      mockCreateFnAgent.mockImplementation(async () => createMockAgent([createQuestionJson()]));

      await expect(retryTargetInterviewSession(sessionId, "/tmp/project")).resolves.not.toThrow();
    });

    it("throws when retrying a non-error session", async () => {
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "slice",
        "sl-no-error",
        "Not Error",
        undefined,
        "/tmp/project"
      );
      await waitForCurrentQuestion(sessionId);

      await expect(retryTargetInterviewSession(sessionId, "/tmp")).rejects.toThrow(
        InvalidSessionStateError
      );
    });
  });

  describe("applyTargetInterview", () => {
    // Note: Full end-to-end tests with AI completion are complex due to async agent mocking.
    // These tests verify error handling and integration with MissionStore.

    it("throws when session not found", () => {
      const mockMissionStore = {} as any;
      expect(() => applyTargetInterview("missing", mockMissionStore)).toThrow(
        TargetSessionNotFoundError
      );
    });

    it("persists milestone planning notes and verification to store", async () => {
      // Create a session and set its summary
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "milestone",
        "ms-apply",
        "Apply Test",
        "Mission context",
        "/tmp/project"
      );
      await waitForCurrentQuestion(sessionId);

      // Set the session's summary directly to simulate completed interview
      const session = getTargetInterviewSession(sessionId);
      if (session) {
        (session as any).summary = {
          description: "Refined milestone description",
          planningNotes: "Key decisions: JWT tokens, refresh token support",
          verification: "All auth flows work correctly",
        };
      }

      // Mock MissionStore
      const mockUpdateMilestone = vi.fn().mockReturnValue({ id: "ms-apply" });
      const mockGetMilestone = vi.fn().mockReturnValue({ id: "ms-apply", title: "Apply Test" });
      const mockMissionStore = {
        getMilestone: mockGetMilestone,
        updateMilestone: mockUpdateMilestone,
      } as any;

      // Apply the interview results
      const result = applyTargetInterview(sessionId, mockMissionStore);

      // Verify update was called with correct fields
      expect(mockUpdateMilestone).toHaveBeenCalledWith("ms-apply", expect.objectContaining({
        description: "Refined milestone description",
        planningNotes: "Key decisions: JWT tokens, refresh token support",
        verification: "All auth flows work correctly",
        interviewState: "completed",
      }));
    });

    it("persists slice planning notes and planState to store", async () => {
      // Create a slice session
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "slice",
        "sl-apply",
        "Apply Slice Test",
        "Mission | Milestone context",
        "/tmp/project"
      );
      await waitForCurrentQuestion(sessionId);

      // Set the session's summary directly
      const session = getTargetInterviewSession(sessionId);
      if (session) {
        (session as any).summary = {
          description: "Refined slice description",
          planningNotes: "Slice decisions: React Hook Form, Zod validation",
          verification: "All form validations pass",
        };
      }

      // Mock MissionStore
      const mockUpdateSlice = vi.fn().mockReturnValue({ id: "sl-apply" });
      const mockGetSlice = vi.fn().mockReturnValue({ id: "sl-apply", title: "Apply Slice Test" });
      const mockMissionStore = {
        getSlice: mockGetSlice,
        updateSlice: mockUpdateSlice,
      } as any;

      // Apply the interview results
      const result = applyTargetInterview(sessionId, mockMissionStore);

      // Verify update was called with correct fields
      expect(mockUpdateSlice).toHaveBeenCalledWith("sl-apply", expect.objectContaining({
        description: "Refined slice description",
        planningNotes: "Slice decisions: React Hook Form, Zod validation",
        verification: "All form validations pass",
        planState: "planned",
      }));
    });

    it("cleans up session after persisting", async () => {
      // Create a milestone session
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "milestone",
        "ms-cleanup",
        "Cleanup Test",
        "Context",
        "/tmp/project"
      );
      await waitForCurrentQuestion(sessionId);

      // Set the session's summary
      const session = getTargetInterviewSession(sessionId);
      if (session) {
        (session as any).summary = {
          description: "Desc",
          planningNotes: "Notes",
          verification: "Verify",
        };
      }

      // Verify session exists before apply
      expect(getTargetInterviewSession(sessionId)).toBeDefined();

      // Mock MissionStore
      const mockUpdateMilestone = vi.fn().mockReturnValue({ id: "ms-cleanup" });
      const mockGetMilestone = vi.fn().mockReturnValue({ id: "ms-cleanup" });
      const mockMissionStore = {
        getMilestone: mockGetMilestone,
        updateMilestone: mockUpdateMilestone,
      } as any;

      // Apply the interview results
      applyTargetInterview(sessionId, mockMissionStore);

      // Verify session was cleaned up
      expect(getTargetInterviewSession(sessionId)).toBeUndefined();
    });

    it("throws when session has no summary to apply", async () => {
      // Create a session without setting summary
      const sessionId = await createTargetInterviewSession(
        "127.0.0.1",
        "milestone",
        "ms-no-summary",
        "No Summary",
        "Context",
        "/tmp/project"
      );
      await waitForCurrentQuestion(sessionId);

      const mockMissionStore = {
        getMilestone: vi.fn().mockReturnValue({ id: "ms-no-summary" }),
      } as any;

      expect(() => applyTargetInterview(sessionId, mockMissionStore)).toThrow(
        TargetInvalidSessionStateError
      );
    });
  });

  describe("skipTargetInterview", () => {
    it("skips milestone interview and applies mission-level context", () => {
      const mockUpdateMilestone = vi.fn().mockReturnValue({ id: "ms-skip", title: "Skipped" });
      const mockGetMilestone = vi.fn().mockReturnValue({ id: "ms-skip", title: "Skip Test", missionId: "m-1" });
      const mockGetMission = vi.fn().mockReturnValue({ id: "m-1", title: "Parent Mission", description: "Mission desc" });
      const mockMissionStore = {
        getMilestone: mockGetMilestone,
        updateMilestone: mockUpdateMilestone,
        getMission: mockGetMission,
      } as any;

      const result = skipTargetInterview("milestone", "ms-skip", mockMissionStore);

      expect(mockUpdateMilestone).toHaveBeenCalledWith("ms-skip", expect.objectContaining({
        interviewState: "completed",
      }));
      const updateCall = mockUpdateMilestone.mock.calls[0][1];
      expect(updateCall.planningNotes).toContain("Planned using mission-level context");
      expect(updateCall.planningNotes).toContain("Parent Mission");
    });

    it("skips slice interview and applies mission-level context", () => {
      const mockUpdateSlice = vi.fn().mockReturnValue({ id: "sl-skip", title: "Skipped" });
      const mockGetSlice = vi.fn().mockReturnValue({ id: "sl-skip", title: "Skip Test", milestoneId: "ms-1" });
      const mockGetMilestone = vi.fn().mockReturnValue({ id: "ms-1", title: "Parent Milestone", missionId: "m-1" });
      const mockGetMission = vi.fn().mockReturnValue({ id: "m-1", title: "Parent Mission", description: "Mission desc" });
      const mockMissionStore = {
        getSlice: mockGetSlice,
        updateSlice: mockUpdateSlice,
        getMilestone: mockGetMilestone,
        getMission: mockGetMission,
      } as any;

      const result = skipTargetInterview("slice", "sl-skip", mockMissionStore);

      expect(mockUpdateSlice).toHaveBeenCalledWith("sl-skip", expect.objectContaining({
        planState: "planned",
      }));
      const updateCall = mockUpdateSlice.mock.calls[0][1];
      expect(updateCall.planningNotes).toContain("Planned using mission-level context");
      expect(updateCall.planningNotes).toContain("Parent Mission");
      expect(updateCall.planningNotes).toContain("Parent Milestone");
    });

    it("throws when milestone not found", () => {
      const mockMissionStore = {
        getMilestone: vi.fn().mockReturnValue(undefined),
      } as any;
      expect(() => skipTargetInterview("milestone", "missing", mockMissionStore)).toThrow(
        TargetSessionNotFoundError
      );
    });
  });

  describe("stream manager", () => {
    it("subscribes, broadcasts, and cleans up", () => {
      const events: any[] = [];
      const unsubscribe = milestoneSliceInterviewStreamManager.subscribe("stream-test", (event) => {
        events.push(event);
      });

      milestoneSliceInterviewStreamManager.broadcast("stream-test", { type: "thinking", data: "thinking..." });
      milestoneSliceInterviewStreamManager.broadcast("stream-test", { type: "question", data: { id: "q-1" } });

      expect(events.length).toBe(2);

      unsubscribe();
      milestoneSliceInterviewStreamManager.broadcast("stream-test", { type: "complete" });
      expect(events.length).toBe(2); // No new event after unsubscribe
    });

    it("returns buffered events since last event id", () => {
      milestoneSliceInterviewStreamManager.broadcast("buffer-test", { type: "thinking", data: "1" });
      milestoneSliceInterviewStreamManager.broadcast("buffer-test", { type: "thinking", data: "2" });
      milestoneSliceInterviewStreamManager.broadcast("buffer-test", { type: "thinking", data: "3" });

      const events = milestoneSliceInterviewStreamManager.getBufferedEvents("buffer-test", 1);
      expect(events.length).toBe(2); // Events with id 2 and 3
    });

    it("clears buffered events on cleanup", () => {
      milestoneSliceInterviewStreamManager.broadcast("cleanup-test", { type: "complete" });
      milestoneSliceInterviewStreamManager.cleanupSession("cleanup-test");

      const events = milestoneSliceInterviewStreamManager.getBufferedEvents("cleanup-test", 0);
      expect(events.length).toBe(0);
    });
  });

  describe("response parsing", () => {
    it("parses milestone complete response with all fields", () => {
      const json = JSON.stringify({
        type: "complete",
        data: {
          title: "Milestone Title",
          description: "Description",
          planningNotes: "Notes",
          verification: "Verify",
          slices: [
            { title: "Slice 1", verification: "V1" },
            { title: "Slice 2", description: "D2" },
          ],
        },
      });

      const result = parseTargetInterviewResponse(json);
      expect(result.type).toBe("complete");
      const data = result.data as MilestoneInterviewSummary;
      expect(data.title).toBe("Milestone Title");
      expect(data.description).toBe("Description");
      expect(data.planningNotes).toBe("Notes");
      expect(data.verification).toBe("Verify");
      expect(data.slices).toHaveLength(2);
    });

    it("parses slice complete response with features", () => {
      const json = JSON.stringify({
        type: "complete",
        data: {
          title: "Slice Title",
          description: "Slice Description",
          planningNotes: "Slice Notes",
          verification: "Verify Slice",
          features: [
            { title: "Feature 1", acceptanceCriteria: "AC1" },
            { title: "Feature 2", description: "F2 Desc" },
          ],
        },
      });

      const result = parseTargetInterviewResponse(json);
      expect(result.type).toBe("complete");
      const data = result.data as SliceInterviewSummary;
      expect(data.title).toBe("Slice Title");
      expect(data.features).toHaveLength(2);
    });
  });

  describe("system prompts", () => {
    it("has milestone interview system prompt", () => {
      expect(MILESTONE_INTERVIEW_SYSTEM_PROMPT).toContain("milestone");
      expect(MILESTONE_INTERVIEW_SYSTEM_PROMPT).toContain("slice");
      expect(MILESTONE_INTERVIEW_SYSTEM_PROMPT).toContain("verification");
    });

    it("has slice interview system prompt", () => {
      expect(SLICE_INTERVIEW_SYSTEM_PROMPT).toContain("slice");
      expect(SLICE_INTERVIEW_SYSTEM_PROMPT).toContain("feature");
      expect(SLICE_INTERVIEW_SYSTEM_PROMPT).toContain("acceptanceCriteria");
    });
  });

  describe("generation timeout / abort", () => {
    it("marks the session as error when initial generation exceeds GENERATION_TIMEOUT_MS", async () => {
      vi.useFakeTimers();

      let resolveHungPrompt: (() => void) | undefined;
      mockCreateFnAgent.mockImplementationOnce(async () => ({
        session: {
          state: { messages: [] },
          prompt: vi.fn(async () => {
            await new Promise<void>((resolve) => { resolveHungPrompt = resolve; });
          }),
          dispose: vi.fn(),
        },
      }));

      const sessionId = await createTargetInterviewSession(
        "10.0.1.10",
        "milestone",
        "milestone-stuck",
        "Hung milestone interview",
        undefined,
        "/tmp/project",
      );

      // Yield so the guard registration runs.
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);

      const session = getTargetInterviewSession(sessionId);
      expect(session?.error).toMatch(/timed out/i);

      resolveHungPrompt?.();
      await vi.advanceTimersByTimeAsync(0);

      vi.useRealTimers();
    });

    it("stopMilestoneSliceInterviewGeneration aborts an in-flight session and marks it stopped", async () => {
      let resolveHungPrompt: (() => void) | undefined;
      mockCreateFnAgent.mockImplementationOnce(async () => ({
        session: {
          state: { messages: [] },
          prompt: vi.fn(async () => {
            await new Promise<void>((resolve) => { resolveHungPrompt = resolve; });
          }),
          dispose: vi.fn(),
        },
      }));

      const sessionId = await createTargetInterviewSession(
        "10.0.1.11",
        "slice",
        "slice-stoppable",
        "Stoppable slice interview",
        undefined,
        "/tmp/project",
      );

      let stopped = false;
      for (let i = 0; i < 50 && !stopped; i++) {
        stopped = stopMilestoneSliceInterviewGeneration(sessionId);
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(stopped).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 0));

      const session = getTargetInterviewSession(sessionId);
      expect(session?.error).toMatch(/stopped by user/i);
      expect(stopMilestoneSliceInterviewGeneration(sessionId)).toBe(false);

      resolveHungPrompt?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
