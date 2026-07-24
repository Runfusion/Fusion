// @vitest-environment node

/*
FNXC:PlanningQuestionRegeneration 2026-07-23-22:20:
Mission and milestone/slice interviews share Planning Mode's invariant: submitting while a
LIVE session has no active question (e.g. cleared by a failed generation) must regenerate a
fresh question instead of throwing "No active question in session". A completed interview
(summary present) still rejects late submissions.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    buildSessionSkillContextSync: vi.fn(() => ({ skillSelectionContext: undefined })),
    resolveMcpServersForStore: vi.fn(async () => ({ servers: [] })),
    createFnAgent: vi.fn(async () => ({
      session: {
        state: { messages: [] as Array<{ role: string; content: string }> },
        prompt: vi.fn(async function (this: { state: { messages: Array<{ role: string; content: string }> } }) {
          this.state.messages.push({
            role: "assistant",
            content: JSON.stringify({
              type: "question",
              data: { id: "q-regenerated", type: "text", question: "What should we cover next?" },
            }),
          });
        }),
        dispose: vi.fn(),
      },
    })),
  };
});

vi.mock("../planning-board-tools.js", () => ({
  createPlanningBoardTools: vi.fn(() => []),
}));

import {
  __resetMissionInterviewState,
  createMissionInterviewSession,
  getMissionInterviewSession,
  submitMissionInterviewResponse,
} from "../mission-interview.js";
import {
  __resetMilestoneSliceInterviewState,
  createTargetInterviewSession,
  getTargetInterviewSession,
  submitTargetInterviewResponse,
} from "../milestone-slice-interview.js";

const store = {} as never;

describe("interview question regeneration instead of no-active-question errors", () => {
  beforeEach(() => {
    __resetMissionInterviewState();
    __resetMilestoneSliceInterviewState();
  });

  it("mission interview regenerates a question for a live session with no active question", async () => {
    const sessionId = await createMissionInterviewSession(
      "127.0.0.1",
      "Plan reliable interviews",
      "/tmp/fusion-dashboard-test",
      store,
    );
    await vi.waitFor(async () => {
      expect((await getMissionInterviewSession(sessionId))?.currentQuestion).toBeDefined();
    });

    const session = (await getMissionInterviewSession(sessionId))!;
    session.currentQuestion = undefined;
    session.summary = undefined;
    const historyLengthBefore = session.history.length;

    const result = await submitMissionInterviewResponse(sessionId, { "q-stale": "my answer" }, "/tmp/fusion-dashboard-test", store);

    expect(result.type).toBe("question");
    expect(session.error).toBeUndefined();
    expect(session.currentQuestion).toBeDefined();
    expect(session.history.length).toBe(historyLengthBefore);
  });

  it("milestone/slice interview regenerates a question for a live session with no active question", async () => {
    const sessionId = await createTargetInterviewSession(
      "127.0.0.1",
      "milestone",
      "milestone-1",
      "Ship the importer",
      undefined,
      "/tmp/fusion-dashboard-test",
      store,
    );
    await vi.waitFor(async () => {
      expect((await getTargetInterviewSession(sessionId))?.currentQuestion).toBeDefined();
    });

    const session = (await getTargetInterviewSession(sessionId))!;
    session.currentQuestion = undefined;
    session.summary = undefined;
    const historyLengthBefore = session.history.length;

    const result = await submitTargetInterviewResponse(sessionId, { "q-stale": "my answer" }, "/tmp/fusion-dashboard-test", store);

    expect(result.type).toBe("question");
    expect(session.error).toBeUndefined();
    expect(session.currentQuestion).toBeDefined();
    expect(session.history.length).toBe(historyLengthBefore);
  });
});
