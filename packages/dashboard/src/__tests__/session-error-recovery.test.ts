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
  GENERATION_TIMEOUT_MS as PLANNING_GENERATION_TIMEOUT_MS,
  getSession,
  planningStreamManager,
  retrySession,
  setAiSessionStore as setPlanningAiSessionStore,
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
  createFnAgent: mockCreateFnAgent,
}));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-session-error-recovery-"));
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

  it("times out planning sessions when createFnAgent construction stalls", async () => {
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
    expect(aiSessionStore.get(sessionId)?.error).toMatch(/timed out/i);
    expect(errorEvents).toContainEqual(expect.stringMatching(/timed out/i));
    expect(__getActiveGenerationForTests(sessionId)).toBeUndefined();

    unsubscribe();
  });

  it("times out planning sessions when prompt stalls and disposes the agent", async () => {
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
    expect(aiSessionStore.get(sessionId)?.error).toMatch(/timed out/i);
    expect(errorEvents).toContainEqual(expect.stringMatching(/timed out/i));
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
});
