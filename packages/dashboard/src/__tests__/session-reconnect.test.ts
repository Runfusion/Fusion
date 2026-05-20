/**
 * Covers SSE reconnect behavior: Last-Event-ID replay, reconnect catch-up,
 * and keep-alive ping handling for persisted AI sessions.
 */

// @vitest-environment node

import express from "express";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request, get } from "../test-request.js";
import { AiSessionStore, type AiSessionRow } from "../ai-session-store.js";
import {
  __resetPlanningState,
  __setCreateFnAgent,
  createSession,
  submitResponse,
  setAiSessionStore as setPlanningAiSessionStore,
} from "../planning.js";
import {
  __resetSubtaskBreakdownState,
  createSubtaskSession,
  getSubtaskSession,
  setAiSessionStore as setSubtaskAiSessionStore,
} from "../subtask-breakdown.js";
import {
  __resetMissionInterviewState,
  createMissionInterviewSession,
  getMissionInterviewSession,
  submitMissionInterviewResponse,
  setAiSessionStore as setMissionAiSessionStore,
} from "../mission-interview.js";

const { mockCreateFnAgent } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  createFnAgent: mockCreateFnAgent,
  createResolvedAgentSession: vi.fn(async () => ({
    session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() },
    runtimeModel: undefined,
  })),
  ExperimentFinalizeService: class {
    async finalize() {
      return { keptRuns: [], droppedRuns: [], branches: [] };
    }
  },
  defaultGitOps: vi.fn(() => ({})),
  promptWithFallback: vi.fn(async (session: { prompt: (message: string) => Promise<void> }, prompt: string) => {
    await session.prompt(prompt);
  }),
  extractRuntimeHint: vi.fn(() => undefined),
  extractRuntimeModel: vi.fn(() => undefined),
  createSendMessageTool: vi.fn(() => ({})),
  createReadMessagesTool: vi.fn(() => ({})),
}));

function makePlanningAgent(responses: string[]) {
  const messages: Array<{ role: string; content: string }> = [];
  let index = 0;
  return {
    session: {
      state: { messages },
      prompt: vi.fn(async (_input: string) => {
        const response = responses[index++] ?? responses[responses.length - 1] ?? responses[0] ?? "{}";
        messages.push({ role: "assistant", content: response });
      }),
      dispose: vi.fn(),
    },
  };
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function extractEventId(body: string, eventName: string): number {
  const pattern = new RegExp(`id: (\\d+)\\nevent: ${eventName}`, "m");
  const match = body.match(pattern);
  if (!match) {
    throw new Error(`Missing event ${eventName} in body: ${body}`);
  }
  return Number.parseInt(match[1]!, 10);
}

describe("session reconnect + replay", () => {
  let tmpRoot: string;
  let store: TaskStore;
  let aiSessionStore: AiSessionStore;
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetPlanningState();
    __resetSubtaskBreakdownState();
    __resetMissionInterviewState();

    tmpRoot = mkdtempSync(join(tmpdir(), "kb-session-reconnect-"));
    store = new TaskStore(tmpRoot, join(tmpRoot, ".fusion-global-settings"), { inMemoryDb: true });
    await store.init();
    aiSessionStore = new AiSessionStore(store.getDatabase());

    setPlanningAiSessionStore(aiSessionStore);
    setSubtaskAiSessionStore(aiSessionStore);
    setMissionAiSessionStore(aiSessionStore);

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { aiSessionStore }));
  });

  afterEach(async () => {
    __setCreateFnAgent(undefined as any);
    __resetPlanningState();
    __resetSubtaskBreakdownState();
    __resetMissionInterviewState();

    try {
      store.close();
    } catch {
      // no-op
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("replays planning buffered events and supports reconnect catch-up with lastEventId", async () => {
    const planningResponses = [
      JSON.stringify({
        type: "question",
        data: { id: "q-1", type: "text", question: "What scope?" },
      }),
      JSON.stringify({
        type: "question",
        data: { id: "q-2", type: "text", question: "Any constraints?" },
      }),
      JSON.stringify({
        type: "complete",
        data: {
          title: "Planning complete",
          description: "Done",
          suggestedSize: "M",
          suggestedDependencies: [],
          keyDeliverables: ["One", "Two"],
        },
      }),
    ];

    __setCreateFnAgent(async () => makePlanningAgent(planningResponses));

    const { sessionId } = await createSession("127.0.0.11", "Build reconnect tests", store, "/tmp/project");
    await submitResponse(sessionId, { "q-1": "medium" }, "/tmp/project");
    await submitResponse(sessionId, { "q-2": "none" }, "/tmp/project");

    const firstStream = await get(app, `/api/planning/${sessionId}/stream?lastEventId=0`);
    expect(firstStream.status).toBe(200);
    const firstBody = String(firstStream.body);
    expect(firstBody).toContain("event: summary");
    expect(firstBody).toContain("event: complete");

    const completeEventId = extractEventId(firstBody, "complete");

    const reconnect = await get(app, `/api/planning/${sessionId}/stream?lastEventId=${completeEventId}`);
    expect(reconnect.status).toBe(200);
    const reconnectBody = String(reconnect.body);
    expect(reconnectBody).toContain(": connected");
    expect(reconnectBody).not.toContain("event: summary");
    expect(reconnectBody).not.toContain("event: complete");
  });

  it("replays subtask buffered events using Last-Event-ID header", async () => {
    mockCreateFnAgent.mockImplementation(async () =>
      makePlanningAgent([
        JSON.stringify({
          subtasks: [
            {
              id: "subtask-1",
              title: "First",
              description: "Do first",
              suggestedSize: "S",
              dependsOn: [],
            },
          ],
        }),
      ]),
    );

    const session = await createSubtaskSession("Break this down", store, "/tmp/project");
    await waitForCondition(() => getSubtaskSession(session.sessionId)?.status === "complete");

    const initial = await get(app, `/api/subtasks/${session.sessionId}/stream`);
    expect(initial.status).toBe(200);
    const initialBody = String(initial.body);
    expect(initialBody).toContain("event: subtasks");
    expect(initialBody).toContain("event: complete");

    const subtasksEventId = extractEventId(initialBody, "subtasks");

    const replay = await request(
      app,
      "GET",
      `/api/subtasks/${session.sessionId}/stream`,
      undefined,
      { "Last-Event-ID": String(subtasksEventId) },
    );

    expect(replay.status).toBe(200);
    const replayBody = String(replay.body);
    expect(replayBody).toContain("event: complete");
    expect(replayBody).not.toContain("event: subtasks");
  });

  it("replays mission interview buffered events using query lastEventId", async () => {
    mockCreateFnAgent.mockImplementation(async () =>
      makePlanningAgent([
        JSON.stringify({
          type: "question",
          data: { id: "q-m-1", type: "text", question: "What is the mission?" },
        }),
        JSON.stringify({
          type: "complete",
          data: {
            missionTitle: "Mission summary",
            missionDescription: "Done",
            milestones: [
              {
                title: "Milestone 1",
                slices: [
                  {
                    title: "Slice 1",
                    features: [{ title: "Feature 1", acceptanceCriteria: "Works" }],
                  },
                ],
              },
            ],
          },
        }),
      ]),
    );

    const sessionId = await createMissionInterviewSession("127.0.0.22", "Mission reconnect", "/tmp/project");
    await waitForCondition(() => Boolean(getMissionInterviewSession(sessionId)?.currentQuestion));

    await submitMissionInterviewResponse(sessionId, { "q-m-1": "Build the system" }, "/tmp/project");

    const initial = await get(app, `/api/missions/interview/${sessionId}/stream`);
    expect(initial.status).toBe(200);
    const initialBody = String(initial.body);
    expect(initialBody).toContain("event: summary");
    expect(initialBody).toContain("event: complete");

    const summaryEventId = extractEventId(initialBody, "summary");

    const replay = await get(app, `/api/missions/interview/${sessionId}/stream?lastEventId=${summaryEventId}`);
    expect(replay.status).toBe(200);
    const replayBody = String(replay.body);
    expect(replayBody).toContain("event: complete");
    expect(replayBody).not.toContain("event: summary");
  });

  it("accepts keep-alive ping touches via /api/ai-sessions/:id/ping", async () => {
    const sessionId = "ping-session-1";
    const stale = new Date(Date.now() - 90_000).toISOString();

    const row: AiSessionRow = {
      id: sessionId,
      type: "planning",
      status: "awaiting_input",
      title: "Ping session",
      inputPayload: JSON.stringify({ initialPlan: "Ping" }),
      conversationHistory: "[]",
      currentQuestion: null,
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: stale,
      updatedAt: stale,
      lockedByTab: null,
      lockedAt: null,
    };

    aiSessionStore.upsert(row);
    store.getDatabase().prepare("UPDATE ai_sessions SET updatedAt = ? WHERE id = ?").run(stale, sessionId);

    const response = await request(app, "POST", `/api/ai-sessions/${sessionId}/ping`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const updated = aiSessionStore.get(sessionId);
    expect(updated).not.toBeNull();
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThan(Date.parse(stale));
  });
});
