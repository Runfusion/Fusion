/**
 * Covers SQLite persistence round-trips for planning, subtask, and mission sessions,
 * including transition snapshots, recovery, and delete semantics.
 */

// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Database,
  PLANNING_DEEPEN_CHECKPOINT_ID,
  PLANNING_DEEPEN_CHECKPOINT_QUESTION,
  PLANNING_DEEPEN_PROCEED_OPTION_ID,
  TaskStore,
} from "@fusion/core";
import { AiSessionStore, type AiSessionRow } from "../ai-session-store.js";
import {
  __resetPlanningState,
  __setCreateFnAgent,
  cancelSession,
  createSession,
  getCurrentQuestion,
  rehydrateFromStore,
  setAiSessionStore as setPlanningAiSessionStore,
  submitResponse,
} from "../planning.js";
import {
  __resetSubtaskBreakdownState,
  createSubtaskSession,
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
  // FNXC:DashboardSessionTests 2026-06-14-09:06: planning.ts spreads createWorkflowAuthoringTools into agent customTools; this focused engine mock must export it to keep AI-session tests aligned with production planning setup.
  createWorkflowAuthoringTools: vi.fn(() => []),
  // FNXC:DashboardSessionTests 2026-06-18-09:12: planning.ts also spreads chat task document tools during dashboard API backfill runs; focused engine mocks must return an iterable list so rescued chat-routes coverage does not destabilize planning-session tests.
  createChatTaskDocumentTools: vi.fn(() => []),
  createChatArtifactTools: vi.fn(() => []),
  // FNXC:DashboardSessionTests 2026-06-17-19:33: planning and mission-interview sessions now request skills through the shared helper; focused engine mocks must return the shaped helper result so lifecycle tests do not crash before createFnAgent is captured.
  buildSessionSkillContextSync: vi.fn(() => ({
    skillSelectionContext: undefined,
    resolvedSkillNames: [],
    skillSource: "none" as const,
  })),
  resolveMcpServersForStore: vi.fn(async () => ({ servers: [] })),
  createFnAgent: mockCreateFnAgent,
}));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-session-roundtrip-"));
}

function createMockAgent(responses: string[]) {
  const messages: Array<{ role: string; content: string }> = [];
  let index = 0;

  return {
    session: {
      state: { messages },
      prompt: vi.fn(async (_message: string) => {
        const response = responses[index++] ?? responses[responses.length - 1] ?? responses[0] ?? "{}";
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

describe("session persistence round-trip", () => {
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

  it("persists planning session transitions across generating → awaiting checkpoint → complete", async () => {
    __setCreateFnAgent(
      async () =>
        createMockAgent([
          JSON.stringify({
            type: "question",
            data: { id: "q-1", type: "text", question: "First question" },
          }),
          JSON.stringify({
            type: "question",
            data: { id: "q-2", type: "text", question: "Second question" },
          }),
          JSON.stringify({
            type: "complete",
            data: {
              title: "Planned",
              description: "Plan summary",
              suggestedSize: "M",
              suggestedDependencies: [],
              keyDeliverables: ["One", "Two"],
            },
          }),
        ]),
    );

    const { sessionId } = await createSession("127.0.0.31", "Plan persistence", taskStore, "/tmp/project");

    const afterCreate = aiSessionStore.get(sessionId);
    expect(afterCreate?.status).toBe("awaiting_input");
    expect(JSON.parse(afterCreate?.conversationHistory ?? "[]")).toEqual([]);
    expect(JSON.parse(afterCreate?.currentQuestion ?? "null")?.id).toBe("q-1");

    await submitResponse(sessionId, { "q-1": "Answer one" }, "/tmp/project");
    const afterFirstResponse = aiSessionStore.get(sessionId);
    expect(afterFirstResponse?.status).toBe("awaiting_input");
    expect(JSON.parse(afterFirstResponse?.currentQuestion ?? "null")?.id).toBe("q-2");
    expect(JSON.parse(afterFirstResponse?.conversationHistory ?? "[]")).toHaveLength(1);

    await submitResponse(sessionId, { "q-2": "Answer two" }, "/tmp/project");
    const afterCheckpoint = aiSessionStore.get(sessionId);
    expect(afterCheckpoint?.status).toBe("awaiting_input");
    expect(JSON.parse(afterCheckpoint?.currentQuestion ?? "null")).toMatchObject({
      id: PLANNING_DEEPEN_CHECKPOINT_ID,
      question: PLANNING_DEEPEN_CHECKPOINT_QUESTION,
    });
    expect(JSON.parse(afterCheckpoint?.conversationHistory ?? "[]")).toHaveLength(2);
    expect(afterCheckpoint?.result).toBeNull();
    expect(JSON.parse(afterCheckpoint?.inputPayload ?? "{}").pendingSummary.title).toBe("Planned");

    await submitResponse(
      sessionId,
      { [PLANNING_DEEPEN_CHECKPOINT_ID]: [PLANNING_DEEPEN_PROCEED_OPTION_ID] },
      "/tmp/project",
    );
    const afterComplete = aiSessionStore.get(sessionId);
    expect(afterComplete?.status).toBe("complete");
    expect(afterComplete?.currentQuestion).toBeNull();
    expect(JSON.parse(afterComplete?.conversationHistory ?? "[]")).toHaveLength(3);
    expect(JSON.parse(afterComplete?.inputPayload ?? "{}").pendingSummary).toBeUndefined();
    expect(JSON.parse(afterComplete?.result ?? "null")?.title).toBe("Planned");
  });

  it("rehydrates awaiting deepening checkpoint sessions without exposing pending summary as complete", () => {
    const now = new Date().toISOString();
    aiSessionStore.upsert({
      id: "planning-checkpoint-recover",
      type: "planning",
      status: "awaiting_input",
      title: "Planning checkpoint recover",
      inputPayload: JSON.stringify({
        ip: "127.0.0.1",
        initialPlan: "Plan",
        pendingSummary: {
          title: "Recovered pending summary",
          description: "Summary is waiting behind checkpoint",
          suggestedSize: "M",
          suggestedDependencies: ["FN-1", "FN-1"],
          keyDeliverables: ["One"],
        },
      }),
      conversationHistory: JSON.stringify([{ question: { id: "q-1", type: "text", question: "First?" }, response: { "q-1": "a" } }]),
      currentQuestion: JSON.stringify({
        id: PLANNING_DEEPEN_CHECKPOINT_ID,
        type: "multi_select",
        question: PLANNING_DEEPEN_CHECKPOINT_QUESTION,
        options: [{ id: PLANNING_DEEPEN_PROCEED_OPTION_ID, label: "Proceed to final plan" }],
      }),
      result: null,
      thinkingOutput: "",
      error: null,
      projectId: null,
      createdAt: now,
      updatedAt: now,
      lockedByTab: null,
      lockedAt: null,
    });

    expect(rehydrateFromStore(aiSessionStore)).toBe(1);
    expect(getCurrentQuestion("planning-checkpoint-recover")).toMatchObject({
      id: PLANNING_DEEPEN_CHECKPOINT_ID,
      question: PLANNING_DEEPEN_CHECKPOINT_QUESTION,
    });
    expect(aiSessionStore.get("planning-checkpoint-recover")?.result).toBeNull();
  });

  it("recovers generating sessions from SQLite while preserving history and currentQuestion", () => {
    const now = new Date().toISOString();

    const rows: AiSessionRow[] = [
      {
        id: "planning-recover",
        type: "planning",
        status: "generating",
        title: "Planning recover",
        inputPayload: JSON.stringify({ initialPlan: "Plan" }),
        conversationHistory: JSON.stringify([{ question: { id: "q-1" }, response: { "q-1": "a" } }]),
        currentQuestion: JSON.stringify({ id: "q-2", type: "text", question: "Next?" }),
        result: null,
        thinkingOutput: "thinking",
        error: null,
        projectId: null,
        createdAt: now,
        updatedAt: now,
        lockedByTab: null,
        lockedAt: null,
      },
      {
        id: "subtask-recover",
        type: "subtask",
        status: "generating",
        title: "Subtask recover",
        inputPayload: JSON.stringify({ initialDescription: "Breakdown" }),
        conversationHistory: JSON.stringify([{ note: "history" }]),
        currentQuestion: JSON.stringify({ id: "q-sub", type: "text", question: "placeholder" }),
        result: null,
        thinkingOutput: "thinking",
        error: null,
        projectId: null,
        createdAt: now,
        updatedAt: now,
        lockedByTab: null,
        lockedAt: null,
      },
      {
        id: "mission-recover",
        type: "mission_interview",
        status: "generating",
        title: "Mission recover",
        inputPayload: JSON.stringify({ missionTitle: "Mission" }),
        conversationHistory: JSON.stringify([{ question: { id: "q-m" }, response: { "q-m": "a" } }]),
        currentQuestion: JSON.stringify({ id: "q-m-2", type: "text", question: "Next mission question" }),
        result: null,
        thinkingOutput: "thinking",
        error: null,
        projectId: null,
        createdAt: now,
        updatedAt: now,
        lockedByTab: null,
        lockedAt: null,
      },
    ];

    for (const row of rows) {
      aiSessionStore.upsert(row);
    }

    const recoveredCount = aiSessionStore.recoverStaleSessions();
    expect(recoveredCount).toBe(3);

    for (const row of rows) {
      const recovered = aiSessionStore.get(row.id);
      expect(recovered?.status).toBe("awaiting_input");
      expect(JSON.parse(recovered?.conversationHistory ?? "[]")).toEqual(JSON.parse(row.conversationHistory));
      expect(JSON.parse(recovered?.currentQuestion ?? "null")).toEqual(JSON.parse(row.currentQuestion ?? "null"));
    }
  });

  it("persists completed subtask results into AiSessionStore result JSON", async () => {
    mockCreateFnAgent.mockImplementation(async () =>
      createMockAgent([
        JSON.stringify({
          subtasks: [
            {
              id: "subtask-1",
              title: "Prepare",
              description: "Prepare setup",
              suggestedSize: "S",
              dependsOn: [],
            },
            {
              id: "subtask-2",
              title: "Implement",
              description: "Implement feature",
              suggestedSize: "M",
              dependsOn: ["subtask-1"],
            },
          ],
        }),
      ]),
    );

    const session = await createSubtaskSession("Generate subtasks", undefined, "/tmp/project");

    await waitFor(() => aiSessionStore.get(session.sessionId)?.status === "complete");

    const persisted = aiSessionStore.get(session.sessionId);
    expect(persisted?.status).toBe("complete");

    const result = JSON.parse(persisted?.result ?? "[]") as Array<{ title: string }>;
    expect(result.map((subtask) => subtask.title)).toEqual(["Prepare", "Implement"]);
  });

  it("persists mission interview history and result round-trip", async () => {
    mockCreateFnAgent.mockImplementation(async () =>
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "q-m-1", type: "text", question: "What are we building?" },
        }),
        JSON.stringify({
          type: "complete",
          data: {
            missionTitle: "Mission Plan",
            missionDescription: "Plan details",
            milestones: [
              {
                title: "Milestone A",
                slices: [
                  {
                    title: "Slice A",
                    features: [{ title: "Feature A", acceptanceCriteria: "Pass" }],
                  },
                ],
              },
            ],
          },
        }),
      ]),
    );

    const sessionId = await createMissionInterviewSession(
      "127.0.0.44",
      "Mission persistence",
      "/tmp/project",
      taskStore,
      undefined,
      undefined,
      undefined,
      "project-mission",
    );
    await waitFor(() => Boolean(getMissionInterviewSession(sessionId)?.currentQuestion));

    await submitMissionInterviewResponse(sessionId, { "q-m-1": "A mission" }, "/tmp/project");

    const persisted = aiSessionStore.get(sessionId);
    expect(persisted?.status).toBe("complete");
    expect(persisted?.projectId).toBe("project-mission");

    const history = JSON.parse(persisted?.conversationHistory ?? "[]") as Array<{ question: { id: string } }>;
    expect(history).toHaveLength(1);
    expect(history[0]?.question.id).toBe("q-m-1");

    const result = JSON.parse(persisted?.result ?? "null") as { missionTitle?: string };
    expect(result?.missionTitle).toBe("Mission Plan");
  });

  it("removes persisted rows when a planning session is cancelled", async () => {
    __setCreateFnAgent(
      async () =>
        createMockAgent([
          JSON.stringify({
            type: "question",
            data: { id: "q-cancel", type: "text", question: "Cancel me?" },
          }),
        ]),
    );

    const { sessionId } = await createSession("127.0.0.55", "Cancel persistence", taskStore, "/tmp/project");
    expect(aiSessionStore.get(sessionId)).not.toBeNull();

    await cancelSession(sessionId);

    expect(aiSessionStore.get(sessionId)).toBeNull();
  });
});
