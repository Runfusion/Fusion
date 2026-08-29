// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THINKING_LEVELS, type ThinkingLevel } from "@fusion/core";

const { buildSessionSkillContextSyncMock } = vi.hoisted(() => ({
  buildSessionSkillContextSyncMock: vi.fn(() => ({ skillSelectionContext: undefined })),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    buildSessionSkillContextSync: buildSessionSkillContextSyncMock,
    resolveMcpServersForStore: vi.fn(async () => ({ servers: [] })),
    createFnAgent: vi.fn(async () => ({
      session: {
        state: { messages: [] as Array<{ role: string; content: string }> },
        prompt: vi.fn(async function (this: { state: { messages: Array<{ role: string; content: string }> } }) {
          this.state.messages.push({
            role: "assistant",
            content: JSON.stringify({
              type: "question",
              data: { id: "scope", type: "text", question: "What should this mission accomplish?" },
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
} from "../mission-interview.js";
import { resolveMissionInterviewThinkingLevel } from "../mission-routes.js";

const store = {} as never;
const pluginRunner = { getPluginSkills: vi.fn(() => []) };

async function createSession(thinkingLevel: ThinkingLevel | undefined, projectId: string | null) {
  const sessionId = await createMissionInterviewSession(
    "127.0.0.1",
    "Plan reliable interviews",
    "/tmp/fusion-dashboard-test",
    store,
    undefined,
    undefined,
    undefined,
    thinkingLevel,
    projectId,
    pluginRunner,
  );
  await vi.waitFor(() => expect(buildSessionSkillContextSyncMock).toHaveBeenCalled());
  return getMissionInterviewSession(sessionId);
}

describe("mission interview thinking-level argument binding", () => {
  beforeEach(() => {
    __resetMissionInterviewState();
    buildSessionSkillContextSyncMock.mockClear();
    pluginRunner.getPluginSkills.mockClear();
  });

  afterEach(() => {
    __resetMissionInterviewState();
  });

  it("preserves the plugin runner and project scope when thinkingLevel is omitted", async () => {
    const session = await createSession(undefined, "proj-1");

    expect(session?.projectId).toBe("proj-1");
    expect(session?.pluginRunner).toBe(pluginRunner);
    expect(session?.error).toBeUndefined();
    expect(buildSessionSkillContextSyncMock).toHaveBeenCalledWith(null, "executor", "/tmp/fusion-dashboard-test", pluginRunner);
    expect(session?.error).not.toBe("pluginRunner.getPluginSkills is not a function");
  });

  it("does not silently discard a real plugin runner for an unscoped omitted-thinking start", async () => {
    const session = await createSession(undefined, null);

    expect(session?.projectId).toBeNull();
    expect(session?.pluginRunner).toBe(pluginRunner);
    expect(session?.error).toBeUndefined();
    expect(buildSessionSkillContextSyncMock).toHaveBeenCalledWith(null, "executor", "/tmp/fusion-dashboard-test", pluginRunner);
  });

  it.each(THINKING_LEVELS)("keeps plugin runner and project scope bound for %s", async (thinkingLevel) => {
    const session = await createSession(thinkingLevel, "proj-1");

    expect(session?.thinkingLevel).toBe(thinkingLevel);
    expect(session?.projectId).toBe("proj-1");
    expect(session?.pluginRunner).toBe(pluginRunner);
    expect(buildSessionSkillContextSyncMock).toHaveBeenCalledWith(null, "executor", "/tmp/fusion-dashboard-test", pluginRunner);
  });

  it("uses planning settings only when the request omits thinkingLevel", () => {
    expect(resolveMissionInterviewThinkingLevel({ planningThinkingLevel: "high", defaultThinkingLevel: "low" }, undefined)).toBe("high");
    expect(resolveMissionInterviewThinkingLevel({ planningThinkingLevel: "high" }, "minimal")).toBe("minimal");
  });
});
