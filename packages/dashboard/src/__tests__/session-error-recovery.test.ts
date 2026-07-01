/**
 * Covers error-state persistence, SSE error broadcasts, and retry recovery flows
 * for planning, subtask breakdown, and mission interview sessions.
 */

// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, TaskStore } from "@fusion/core";
import { AiSessionStore } from "../ai-session-store.js";
import {
  __resetPlanningState,
  __getActiveGenerationForTests,
  __setCreateFnAgent,
  createSession,
  createSessionWithAgent,
  GENERATION_LOOP_REPEAT_LIMIT,
  GENERATION_TIMEOUT_MS as PLANNING_GENERATION_TIMEOUT_MS,
  getSession,
  parseAgentResponse,
  planningStreamManager,
  retrySession,
  setAiSessionStore as setPlanningAiSessionStore,
  stopGeneration,
  submitResponse,
} from "../planning.js";
import {
  __resetSubtaskBreakdownState,
  createSubtaskSession,
  getSubtaskSession,
  retrySubtaskSession,
  setAiSessionStore as setSubtaskAiSessionStore,
  subtaskStreamManager,
} from "../subtask-breakdown.js";
import {
  __resetMissionInterviewState,
  createMissionInterviewSession,
  getMissionInterviewSession,
  missionInterviewStreamManager,
  retryMissionInterviewSession,
  setAiSessionStore as setMissionAiSessionStore,
  submitMissionInterviewResponse,
} from "../mission-interview.js";

const { mockCreateFnAgent } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  // FNXC:DashboardSessionTests 2026-06-14-09:06: planning.ts spreads createWorkflowAuthoringTools into agent customTools; this focused engine mock must export it to keep AI-session tests aligned with production planning setup.
  createWorkflowAuthoringTools: vi.fn(() => []),
  // FNXC:DashboardSessionTests 2026-06-18-09:12: planning.ts also spreads chat task document tools during dashboard API backfill runs; focused engine mocks must return an iterable list so rescued chat-routes coverage does not destabilize planning-session tests.
  createChatTaskDocumentTools: vi.fn(() => []),
  createChatArtifactTools: vi.fn(() => []),
  // FNXC:DashboardSessionTests 2026-06-17-19:33: planning and mission-interview sessions now request skills through the shared helper; focused engine mocks must return the shaped helper result so lifecycle tests do not crash before createFnAgent is captured.
  resolveMcpServersForStore: vi.fn(() => ({ servers: [] })),
  buildSessionSkillContextSync: vi.fn(() => ({
    skillSelectionContext: undefined,
    resolvedSkillNames: [],
    skillSource: "none" as const,
  })),
  createFnAgent: mockCreateFnAgent,
}));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-session-error-recovery-"));
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createMockAgent(responses: string[]) {
  const queue = [...responses];
  const messages: Array<{ role: string; content: string }> = [];

  return {
    session: {
      state: { messages },
      prompt: vi.fn(async (_input: string) => {
        const response = queue.shift() ?? queue[queue.length - 1] ?? "{}";
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function flushUnhandledRejectionTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("session error recovery", () => {
  let tmpDir: string;
  let db: Database;
  let aiSessionStore: AiSessionStore;
  let taskStore: TaskStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetPlanningState();
    __resetSubtaskBreakdownState();
    __resetMissionInterviewState();

    tmpDir = makeTmpDir();
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
    aiSessionStore = new AiSessionStore(db);
    taskStore = new TaskStore(tmpDir, join(tmpDir, ".fusion-global-settings"), { inMemoryDb: true });
    await taskStore.init();

    setPlanningAiSessionStore(aiSessionStore);
    setSubtaskAiSessionStore(aiSessionStore);
    setMissionAiSessionStore(aiSessionStore);
  });

  afterEach(async () => {
    vi.useRealTimers();
    __setCreateFnAgent(undefined as any);
    __resetPlanningState();
    __resetSubtaskBreakdownState();
    __resetMissionInterviewState();

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

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("recovers a streaming initial-turn prose response when the bounded reformat succeeds", async () => {
    const errorEvents: string[] = [];
    const questionEvents: string[] = [];

    __setCreateFnAgent(
      async () =>
        createMockAgent([
          "I should ask a question next, but I forgot the JSON wrapper.",
          JSON.stringify({
            type: "question",
            data: { id: "q-reformatted", type: "text", question: "Recovered initial question" },
          }),
        ]),
    );

    const sessionId = await createSessionWithAgent(
      "127.0.0.102",
      "Streaming malformed first turn",
      "/tmp/project",
      taskStore,
    );
    const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") errorEvents.push(String(event.data));
      if (event.type === "question") questionEvents.push(String((event.data as { id?: string }).id));
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();

    await waitFor(() => aiSessionStore.get(sessionId)?.status === "awaiting_input");

    const persisted = aiSessionStore.get(sessionId);
    expect(persisted?.status).toBe("awaiting_input");
    expect(persisted?.error).toBeNull();
    expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-reformatted");
    expect(questionEvents).toContain("q-reformatted");
    expect(errorEvents).toEqual([]);

    unsubscribe();
  });

  it("keeps a streaming initial-turn parse failure retryable and recovers on retry", async () => {
    const errorEvents: string[] = [];

    __setCreateFnAgent(
      async () =>
        createMockAgent([
          "I can help plan this, but this response is prose only.",
          "Still prose only after the bounded reformat request.",
        ]),
    );

    const sessionId = await createSessionWithAgent(
      "127.0.0.103",
      "Streaming unrecoverable first turn",
      "/tmp/project",
      taskStore,
    );
    const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") {
        errorEvents.push(String(event.data));
      }
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();

    await waitFor(() => aiSessionStore.get(sessionId)?.status === "error");

    const persistedError = aiSessionStore.get(sessionId);
    expect(persistedError?.status).toBe("error");
    expect(persistedError?.error).toContain("AI returned no valid JSON");
    expect(JSON.parse(persistedError?.conversationHistory ?? "[]")).toHaveLength(0);
    expect(errorEvents).toContainEqual(expect.stringContaining("AI returned no valid JSON"));
    expect(getSession(sessionId)).toBeDefined();

    __setCreateFnAgent(
      async () =>
        createMockAgent([
          JSON.stringify({
            type: "question",
            data: { id: "q-retry-initial", type: "text", question: "Recovered retry question" },
          }),
        ]),
    );

    await retrySession(sessionId, "/tmp/project", undefined, taskStore);

    const persistedRecovered = aiSessionStore.get(sessionId);
    expect(persistedRecovered?.status).toBe("awaiting_input");
    expect(persistedRecovered?.error).toBeNull();
    expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-retry-initial");

    unsubscribe();
  });

  it("keeps a non-streaming initial-turn parse failure persisted for retry", async () => {
    __setCreateFnAgent(
      async () =>
        createMockAgent([
          "This non-streaming first response is prose only.",
          "Still not JSON after the bounded reformat request.",
        ]),
    );

    await expect(
      createSession("127.0.0.104", "Non-streaming unrecoverable first turn", taskStore, "/tmp/project"),
    ).rejects.toThrow("Failed to get first question from AI");

    const failedSession = aiSessionStore.listActive().find((session) => session.type === "planning");
    expect(failedSession?.status).toBe("error");
    expect(failedSession?.id).toBeTruthy();
    const sessionId = failedSession?.id as string;
    expect(aiSessionStore.get(sessionId)?.error).toContain("AI returned no valid JSON");
    expect(getSession(sessionId)).toBeDefined();

    __setCreateFnAgent(
      async () =>
        createMockAgent([
          JSON.stringify({
            type: "question",
            data: { id: "q-nonstream-retry", type: "text", question: "Recovered non-streaming retry" },
          }),
        ]),
    );

    await retrySession(sessionId, "/tmp/project", undefined, taskStore);

    expect(aiSessionStore.get(sessionId)?.status).toBe("awaiting_input");
    expect(aiSessionStore.get(sessionId)?.error).toBeNull();
    expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-nonstream-retry");
  });

  it("selects a valid planning JSON object over a larger unrelated JSON candidate", () => {
    const parsed = parseAgentResponse(`Here is an unrelated object first:
{"metadata":{"items":[{"label":"not planning","details":"${"x".repeat(200)}"}]}}
The actual planning response is:
{"type":"question","data":{"id":"q-small","type":"text","question":"What should we build?"}}`);

    expect(parsed.type).toBe("question");
    if (parsed.type === "question") {
      expect(parsed.data.id).toBe("q-small");
    }
  });

  it("captures planning parse failures as error state, preserves history, and allows retry", async () => {
    const errorEvents: string[] = [];
    const unsubscribe = planningStreamManager.subscribe("pending", () => {
      // placeholder; replaced below once session id exists
    });
    unsubscribe();

    __setCreateFnAgent(
      async () =>
        createMockAgent([
          JSON.stringify({
            type: "question",
            data: { id: "q-1", type: "text", question: "First question" },
          }),
          "not-json",
          "still-not-json",
        ]),
    );

    const { sessionId } = await createSession("127.0.0.101", "Planning error flow", taskStore, "/tmp/project");

    const unsubscribeError = planningStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") {
        errorEvents.push(String(event.data));
      }
    });

    const responseAfterFailure = await submitResponse(
      sessionId,
      { "q-1": "trigger error" },
      "/tmp/project",
    );
    expect(responseAfterFailure.type).toBe("question");
    if (responseAfterFailure.type === "question") {
      // currentQuestion remains the same when parsing fails
      expect(responseAfterFailure.data.id).toBe("q-1");
    }

    const persistedError = aiSessionStore.get(sessionId);
    expect(persistedError?.status).toBe("error");
    expect(persistedError?.error).toContain("AI returned no valid JSON");
    expect(JSON.parse(persistedError?.conversationHistory ?? "[]")).toHaveLength(1);
    expect(errorEvents.length).toBeGreaterThan(0);

    __setCreateFnAgent(
      async () =>
        createMockAgent([
          JSON.stringify({
            type: "question",
            data: { id: "q-retry", type: "text", question: "Recovered question" },
          }),
        ]),
    );

    await retrySession(sessionId, "/tmp/project");

    const persistedRecovered = aiSessionStore.get(sessionId);
    expect(persistedRecovered?.status).toBe("awaiting_input");
    expect(persistedRecovered?.error).toBeNull();
    expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-retry");

    unsubscribeError();
  });

  it("allows meaningful planning progress beyond the old fixed generation deadline", async () => {
    vi.useFakeTimers();

    const promptDeferred = createDeferred();
    const messages: Array<{ role: string; content: string }> = [];
    let streamOptions: { onThinking?: (delta: string) => void; onText?: (delta: string) => void } | undefined;

    __setCreateFnAgent(async (options: { onThinking?: (delta: string) => void; onText?: (delta: string) => void }) => {
      streamOptions = options;
      return {
        session: {
          state: { messages },
          prompt: vi.fn(async () => {
            await promptDeferred.promise;
            messages.push({
              role: "assistant",
              content: JSON.stringify({
                type: "question",
                data: { id: "q-long-progress", type: "text", question: "What should we build next?" },
              }),
            });
          }),
          dispose: vi.fn(),
        },
      };
    });

    const sessionId = await createSessionWithAgent(
      "127.0.0.149",
      "Planning long reasoning",
      "/tmp/project",
      taskStore,
    );
    const errorEvents: string[] = [];
    const questionEvents: string[] = [];
    const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") errorEvents.push(String(event.data));
      if (event.type === "question") questionEvents.push(String((event.data as { id?: string }).id));
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(__getActiveGenerationForTests(sessionId)).toBeDefined();

    streamOptions?.onThinking?.("Considering the project context");
    await vi.advanceTimersByTimeAsync(PLANNING_GENERATION_TIMEOUT_MS / 2);
    streamOptions?.onText?.("Drafting a focused planning question");
    await vi.advanceTimersByTimeAsync(PLANNING_GENERATION_TIMEOUT_MS / 2 + 10_000);

    expect(aiSessionStore.get(sessionId)?.status).toBe("generating");
    expect(aiSessionStore.get(sessionId)?.error).toBeNull();
    expect(errorEvents).toEqual([]);
    expect(__getActiveGenerationForTests(sessionId)).toBeDefined();

    promptDeferred.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(aiSessionStore.get(sessionId)?.status).toBe("awaiting_input");
    expect(aiSessionStore.get(sessionId)?.error).toBeNull();
    expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-long-progress");
    expect(questionEvents).toContain("q-long-progress");
    expect(errorEvents).toEqual([]);
    expect(__getActiveGenerationForTests(sessionId)).toBeUndefined();

    unsubscribe();
  });

  it("marks planning sessions as stuck when createFnAgent construction stalls", async () => {
    vi.useFakeTimers();

    __setCreateFnAgent(async () => {
      await new Promise<never>(() => undefined);
    });

    const sessionId = await createSessionWithAgent(
      "127.0.0.150",
      "Planning construction stall",
      "/tmp/project",
      taskStore,
    );
    const errorEvents: string[] = [];
    const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") {
        errorEvents.push(String(event.data));
      }
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(aiSessionStore.get(sessionId)?.status).toBe("generating");
    expect(__getActiveGenerationForTests(sessionId)).toBeDefined();

    await vi.advanceTimersByTimeAsync(PLANNING_GENERATION_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(aiSessionStore.get(sessionId)?.status).toBe("error");
    expect(aiSessionStore.get(sessionId)?.error).toMatch(/stuck with no new output/i);
    expect(errorEvents).toContainEqual(expect.stringMatching(/stuck with no new output/i));
    expect(__getActiveGenerationForTests(sessionId)).toBeUndefined();

    unsubscribe();
  });

  it("marks planning sessions as stuck when prompt stalls and disposes the agent", async () => {
    vi.useFakeTimers();

    const dispose = vi.fn();
    __setCreateFnAgent(async () => ({
      session: {
        state: { messages: [] },
        prompt: vi.fn(async () => {
          await new Promise<never>(() => undefined);
        }),
        dispose,
      },
    }));

    const sessionId = await createSessionWithAgent(
      "127.0.0.151",
      "Planning prompt stall",
      "/tmp/project",
      taskStore,
    );
    const errorEvents: string[] = [];
    const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") {
        errorEvents.push(String(event.data));
      }
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(__getActiveGenerationForTests(sessionId)).toBeDefined();

    await vi.advanceTimersByTimeAsync(PLANNING_GENERATION_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(aiSessionStore.get(sessionId)?.status).toBe("error");
    expect(aiSessionStore.get(sessionId)?.error).toMatch(/stuck with no new output/i);
    expect(errorEvents).toContainEqual(expect.stringMatching(/stuck with no new output/i));
    expect(__getActiveGenerationForTests(sessionId)).toBeUndefined();
    expect(dispose).toHaveBeenCalled();

    unsubscribe();
  });

  it("stops repeated planning output as a loop and retries to completion", async () => {
    vi.useFakeTimers();

    const dispose = vi.fn();
    let streamOptions: { onText?: (delta: string) => void } | undefined;
    __setCreateFnAgent(async (options: { onText?: (delta: string) => void }) => {
      streamOptions = options;
      return {
        session: {
          state: { messages: [] },
          prompt: vi.fn(async () => {
            await new Promise<never>(() => undefined);
          }),
          dispose,
        },
      };
    });

    const sessionId = await createSessionWithAgent(
      "127.0.0.152",
      "Planning repeated output",
      "/tmp/project",
      taskStore,
    );
    const errorEvents: string[] = [];
    const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") errorEvents.push(String(event.data));
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(__getActiveGenerationForTests(sessionId)).toBeDefined();

    for (let i = 0; i < GENERATION_LOOP_REPEAT_LIMIT + 1; i += 1) {
      streamOptions?.onText?.("same repeated chunk");
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(aiSessionStore.get(sessionId)?.status).toBe("error");
    expect(aiSessionStore.get(sessionId)?.error).toMatch(/repeating the same output/i);
    expect(errorEvents).toContainEqual(expect.stringMatching(/repeating the same output/i));
    expect(__getActiveGenerationForTests(sessionId)).toBeUndefined();
    expect(dispose).toHaveBeenCalled();

    __setCreateFnAgent(
      async () =>
        createMockAgent([
          JSON.stringify({
            type: "question",
            data: { id: "q-loop-retry", type: "text", question: "Recovered after loop" },
          }),
        ]),
    );

    await retrySession(sessionId, "/tmp/project", undefined, taskStore);

    expect(aiSessionStore.get(sessionId)?.status).toBe("awaiting_input");
    expect(aiSessionStore.get(sessionId)?.error).toBeNull();
    expect(getSession(sessionId)?.currentQuestion?.id).toBe("q-loop-retry");

    unsubscribe();
  });

  it("manual stop preserves the user-stopped Planning Mode error", async () => {
    vi.useFakeTimers();

    const dispose = vi.fn();
    __setCreateFnAgent(async () => ({
      session: {
        state: { messages: [] },
        prompt: vi.fn(async () => {
          await new Promise<never>(() => undefined);
        }),
        dispose,
      },
    }));

    const sessionId = await createSessionWithAgent(
      "127.0.0.153",
      "Planning manual stop",
      "/tmp/project",
      taskStore,
    );
    const errorEvents: string[] = [];
    const unsubscribe = planningStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") errorEvents.push(String(event.data));
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopGeneration(sessionId)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(aiSessionStore.get(sessionId)?.status).toBe("error");
    expect(aiSessionStore.get(sessionId)?.error).toMatch(/stopped by user/i);
    expect(errorEvents).toContainEqual(expect.stringMatching(/stopped by user/i));
    expect(__getActiveGenerationForTests(sessionId)).toBeUndefined();
    expect(dispose).toHaveBeenCalled();

    unsubscribe();
  });

  it("captures subtask generation errors, broadcasts SSE error, and retries to completion", async () => {
    const subtaskErrors: string[] = [];

    mockCreateFnAgent.mockImplementationOnce(async () => createMockAgent(["{not-json"]));

    const session = await createSubtaskSession("Subtask error flow", undefined, "/tmp/project");

    const unsubscribe = subtaskStreamManager.subscribe(session.sessionId, (event) => {
      if (event.type === "error") {
        subtaskErrors.push(String(event.data));
      }
    });

    await waitFor(() => aiSessionStore.get(session.sessionId)?.status === "error");

    const persistedError = aiSessionStore.get(session.sessionId);
    expect(persistedError?.status).toBe("error");
    expect(String(persistedError?.error).length).toBeGreaterThan(0);
    expect(subtaskErrors.length).toBeGreaterThan(0);

    mockCreateFnAgent.mockImplementationOnce(async () =>
      createMockAgent([
        JSON.stringify({
          subtasks: [
            {
              id: "subtask-1",
              title: "Recovered",
              description: "Recovered after retry",
              suggestedSize: "S",
              dependsOn: [],
            },
          ],
        }),
      ]),
    );

    await retrySubtaskSession(session.sessionId, "/tmp/project");

    await waitFor(() => aiSessionStore.get(session.sessionId)?.status === "complete");
    expect(getSubtaskSession(session.sessionId)?.status).toBe("complete");
    expect(aiSessionStore.get(session.sessionId)?.error).toBeNull();

    unsubscribe();
  });

  it("captures mission parse failure with history preserved and recovers via retry", async () => {
    const missionErrors: string[] = [];

    mockCreateFnAgent.mockImplementation(async () =>
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "q-m-1", type: "text", question: "Mission question" },
        }),
        "invalid-json",
        "invalid-json-again",
      ]),
    );

    const sessionId = await createMissionInterviewSession("127.0.0.111", "Mission error flow", "/tmp/project", taskStore);
    await waitFor(() => Boolean(getMissionInterviewSession(sessionId)?.currentQuestion));

    const unsubscribe = missionInterviewStreamManager.subscribe(sessionId, (event) => {
      if (event.type === "error") {
        missionErrors.push(String(event.data));
      }
    });

    await submitMissionInterviewResponse(sessionId, { "q-m-1": "trigger mission error" }, "/tmp/project");

    const persistedError = aiSessionStore.get(sessionId);
    expect(persistedError?.status).toBe("error");
    expect(String(persistedError?.error)).toContain("AI returned no valid JSON");
    expect(JSON.parse(persistedError?.conversationHistory ?? "[]")).toHaveLength(1);
    expect(missionErrors.length).toBeGreaterThan(0);

    mockCreateFnAgent.mockImplementation(async () =>
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "q-m-retry", type: "text", question: "Recovered mission question" },
        }),
      ]),
    );

    await retryMissionInterviewSession(sessionId, "/tmp/project");

    const persistedRecovered = aiSessionStore.get(sessionId);
    expect(persistedRecovered?.status).toBe("awaiting_input");
    expect(persistedRecovered?.error).toBeNull();
    expect(getMissionInterviewSession(sessionId)?.currentQuestion?.id).toBe("q-m-retry");

    unsubscribe();
  });

  it("does not leak unhandled rejections when non-streaming parse fails", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      __setCreateFnAgent(
        async () =>
          createMockAgent([
            "Prose only response for unhandled rejection check.",
            "Still prose after reformat attempt.",
          ]),
      );

      await expect(
        createSession("127.0.0.130", "Unhandled rejection test", taskStore, "/tmp/project"),
      ).rejects.toThrow("Failed to get first question from AI");

      await flushUnhandledRejectionTurn();

      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not leak unhandled rejections when streaming parse fails", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandledRejections.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      __setCreateFnAgent(
        async () =>
          createMockAgent([
            "Streaming prose only — no valid JSON.",
            "Still prose after reformat.",
          ]),
      );

      const sessionId = await createSessionWithAgent(
        "127.0.0.131",
        "Streaming unhandled rejection test",
        "/tmp/project",
        taskStore,
      );

      planningStreamManager.consumeInitialTurn(sessionId)?.();

      await waitFor(() => aiSessionStore.get(sessionId)?.status === "error");
      await flushUnhandledRejectionTurn();

      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
