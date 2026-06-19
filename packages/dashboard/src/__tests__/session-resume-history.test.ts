/**
 * Covers resume/restore behavior with persisted conversation history,
 * thinking output continuity, and fresh-session history initialization.
 */

// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, TaskStore } from "@fusion/core";
import { AiSessionStore, type AiSessionRow } from "../ai-session-store.js";
import {
  __resetPlanningState,
  __setCreateFnAgent,
  createSession,
  getSession,
  setAiSessionStore as setPlanningAiSessionStore,
  submitResponse,
} from "../planning.js";
import {
  __resetSubtaskBreakdownState,
  getSubtaskSession,
  setAiSessionStore as setSubtaskAiSessionStore,
} from "../subtask-breakdown.js";
import {
  __resetMissionInterviewState,
  createMissionInterviewSession,
  getMissionInterviewSession,
  setAiSessionStore as setMissionAiSessionStore,
  submitMissionInterviewResponse,
} from "../mission-interview.js";

const { mockCreateFnAgent } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  createWorkflowAuthoringTools: vi.fn(() => []),
  // FNXC:DashboardSessionTests 2026-06-18-09:12: planning.ts also spreads chat task document tools during dashboard API backfill runs; focused engine mocks must return an iterable list so rescued chat-routes coverage does not destabilize planning-session tests.
  createChatTaskDocumentTools: vi.fn(() => []),
  // FNXC:DashboardSessionTests 2026-06-17-19:33: planning and mission-interview sessions now request skills through the shared helper; focused engine mocks must return the shaped helper result so lifecycle tests do not crash before createFnAgent is captured.
  buildSessionSkillContextSync: vi.fn(() => ({
    skillSelectionContext: undefined,
    resolvedSkillNames: [],
    skillSource: "none" as const,
  })),
  createFnAgent: mockCreateFnAgent,
}));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-session-resume-history-"));
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

describe("session resume + history restore", () => {
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

  it("restores planning history/thinking from SQLite and resumes with replayed context", async () => {
    const now = new Date().toISOString();
    const row: AiSessionRow = {
      id: "planning-resume-1",
      type: "planning",
      status: "awaiting_input",
      title: "Planning resume",
      inputPayload: JSON.stringify({ ip: "127.0.0.1", initialPlan: "Resume planning" }),
      conversationHistory: JSON.stringify([
        {
          question: { id: "q-1", type: "text", question: "What are we building?" },
          response: { "q-1": "A resume flow" },
          thinkingOutput: "turn-1-thinking",
        },
      ]),
      currentQuestion: JSON.stringify({ id: "q-2", type: "text", question: "Any constraints?" }),
      result: null,
      thinkingOutput: "latest-thinking",
      error: null,
      projectId: null,
      createdAt: now,
      updatedAt: now,
      lockedByTab: null,
      lockedAt: null,
    };
    aiSessionStore.upsert(row);

    const resumedAgent = createMockAgent([
      "context-ack",
      JSON.stringify({
        type: "question",
        data: { id: "q-3", type: "text", question: "What timeline?" },
      }),
    ]);
    const createFnAgentSpy = vi.fn(async () => resumedAgent);
    __setCreateFnAgent(createFnAgentSpy as any);

    const restored = getSession(row.id);
    expect(restored).toBeDefined();
    expect(restored?.history).toHaveLength(1);
    expect(restored?.history[0]?.thinkingOutput).toBe("turn-1-thinking");
    expect(restored?.thinkingOutput).toBe("latest-thinking");
    expect(restored?.lastGeneratedThinking).toBe("latest-thinking");

    const response = await submitResponse(row.id, { "q-2": "No constraints" }, "/tmp/project", undefined, taskStore);
    expect(response.type).toBe("question");
    if (response.type === "question") {
      expect(response.data.id).toBe("q-3");
    }

    expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
    expect(resumedAgent.session.prompt).toHaveBeenCalledTimes(2);
    expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain("Previous conversation summary");
    expect(resumedAgent.session.prompt.mock.calls[1]?.[0]).toContain("Any constraints?");
  });

  it("restores mission interview history/thinking and resumes with replayed context", async () => {
    const now = new Date().toISOString();
    const row: AiSessionRow = {
      id: "mission-resume-1",
      type: "mission_interview",
      status: "awaiting_input",
      title: "Mission resume",
      inputPayload: JSON.stringify({ ip: "127.0.0.1", missionId: "M-1", missionTitle: "Mission title" }),
      conversationHistory: JSON.stringify([
        {
          question: { id: "q-m-1", type: "text", question: "What is the mission?" },
          response: { "q-m-1": "Ship a dashboard" },
          thinkingOutput: "mission-turn-1-thinking",
        },
      ]),
      currentQuestion: JSON.stringify({ id: "q-m-2", type: "text", question: "Any technical constraints?" }),
      result: null,
      thinkingOutput: "mission-latest-thinking",
      error: null,
      projectId: "project-resume",
      createdAt: now,
      updatedAt: now,
      lockedByTab: null,
      lockedAt: null,
    };
    aiSessionStore.upsert(row);

    const resumedAgent = createMockAgent([
      "context-ack",
      JSON.stringify({
        type: "question",
        data: { id: "q-m-3", type: "text", question: "Who are the users?" },
      }),
    ]);
    const createFnAgentSpy = vi.fn(async () => resumedAgent);
    mockCreateFnAgent.mockImplementation(createFnAgentSpy);

    const restored = getMissionInterviewSession(row.id);
    expect(restored).toBeDefined();
    expect(restored?.history).toHaveLength(1);
    expect(restored?.projectId).toBe("project-resume");
    expect(restored?.history[0]?.thinkingOutput).toBe("mission-turn-1-thinking");
    expect(restored?.thinkingOutput).toBe("mission-latest-thinking");
    expect(restored?.lastGeneratedThinking).toBe("mission-latest-thinking");

    const response = await submitMissionInterviewResponse(
      row.id,
      { "q-m-2": "None" },
      "/tmp/project",
      taskStore,
    );

    expect(response.type).toBe("question");
    if (response.type === "question") {
      expect(response.data.id).toBe("q-m-3");
    }

    expect(createFnAgentSpy).toHaveBeenCalledTimes(1);
    expect(resumedAgent.session.prompt).toHaveBeenCalledTimes(2);
    expect(resumedAgent.session.prompt.mock.calls[0]?.[0]).toContain("Previous conversation summary");
    expect(resumedAgent.session.prompt.mock.calls[1]?.[0]).toContain("Any technical constraints?");
  });

  it("restores persisted subtask session state from SQLite", () => {
    const now = new Date().toISOString();
    const subtasks = [
      {
        id: "subtask-1",
        title: "Analyze",
        description: "Analyze requirements",
        suggestedSize: "S",
        dependsOn: [],
      },
    ];

    const row: AiSessionRow = {
      id: "subtask-resume-1",
      type: "subtask",
      status: "generating",
      title: "Subtask resume",
      inputPayload: JSON.stringify({ initialDescription: "Break down this task" }),
      conversationHistory: JSON.stringify([{ thinkingOutput: "subtask-thinking" }]),
      currentQuestion: null,
      result: JSON.stringify(subtasks),
      thinkingOutput: "subtask-latest-thinking",
      error: null,
      projectId: null,
      createdAt: now,
      updatedAt: now,
      lockedByTab: null,
      lockedAt: null,
    };
    aiSessionStore.upsert(row);

    const restored = getSubtaskSession(row.id);
    expect(restored).toBeDefined();
    expect(restored?.sessionId).toBe(row.id);
    expect(restored?.status).toBe("generating");
    expect(restored?.subtasks).toEqual(subtasks);

    const persistedRow = aiSessionStore.get(row.id);
    expect(JSON.parse(persistedRow?.conversationHistory ?? "[]")).toEqual([
      { thinkingOutput: "subtask-thinking" },
    ]);
  });

  it("starts fresh planning and mission sessions with empty history", async () => {
    __setCreateFnAgent(
      async () =>
        createMockAgent([
          JSON.stringify({
            type: "question",
            data: { id: "q-fresh-plan", type: "text", question: "Plan question" },
          }),
        ]),
    );

    mockCreateFnAgent.mockImplementation(async () =>
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "q-fresh-mission", type: "text", question: "Mission question" },
        }),
      ]),
    );

    const planning = await createSession("127.0.0.88", "Fresh planning", taskStore, "/tmp/project");
    const missionSessionId = await createMissionInterviewSession("127.0.0.89", "Fresh mission", "/tmp/project", taskStore);

    await waitFor(() => Boolean(getMissionInterviewSession(missionSessionId)?.currentQuestion));

    expect(getSession(planning.sessionId)?.history).toEqual([]);
    expect(getMissionInterviewSession(missionSessionId)?.history).toEqual([]);
  });
});
