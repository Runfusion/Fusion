// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  resolveMcpServersForStore: async () => ({ servers: [] }),
  buildSessionSkillContextSync: () => ({
    skillSelectionContext: undefined,
    resolvedSkillNames: ["fusion"],
    skillSource: "role-fallback" as const,
  }),
  createFnAgent: vi.fn(),
  createWorkflowAuthoringTools: () => [],
  createChatTaskDocumentTools: () => [],
  createChatTaskLogsReadTool: () => ({}),
}));

import {
  __resetPlanningState,
  __setCreateFnAgent,
  createSessionWithAgent,
  getSession,
  planningStreamManager,
  setAiSessionStore,
  stopGeneration,
} from "../planning.js";

const MOCK_TASK_STORE = {
  listTasks: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({})),
  getTask: vi.fn(async () => {
    throw new Error("not found");
  }),
} as unknown as TaskStore;

describe("planning generation cancellation", () => {
  const persistSession = vi.fn(async () => {});

  beforeEach(() => {
    __resetPlanningState();
    persistSession.mockClear();
    setAiSessionStore(Object.assign(new EventEmitter(), {
      upsert: persistSession,
      get: vi.fn(async () => null),
    }) as any);
  });

  it("forwards AbortSignal and disposes the in-flight planning prompt on user stop", async () => {
    let resolveHungPrompt: (() => void) | undefined;
    let promptSignal: AbortSignal | undefined;
    let promptResolvedAfterAbort = false;
    const dispose = vi.fn();

    __setCreateFnAgent(vi.fn(async () => ({
      session: {
        state: { messages: [] },
        prompt: vi.fn(async (_message: string, options?: { signal?: AbortSignal }) => {
          promptSignal = options?.signal;
          await new Promise<void>((resolve) => { resolveHungPrompt = resolve; });
          promptResolvedAfterAbort = Boolean(promptSignal?.aborted);
        }),
        dispose,
      },
    })) as any);

    const sessionId = await createSessionWithAgent(
      "10.0.2.10",
      "Plan a cancellable session",
      "/tmp/project",
      MOCK_TASK_STORE,
    );

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    for (let i = 0; i < 10 && !promptSignal; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(promptSignal).toBeDefined();

    const activeSession = await getSession(sessionId);
    activeSession!.summary = {
      title: "Reviewable plan",
      description: "A partial plan that remains useful after stopping.",
      suggestedSize: "M",
      keyDeliverables: ["Resume refinement"],
    };

    expect(stopGeneration(sessionId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(promptSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((await getSession(sessionId))?.error).toBeUndefined();
    expect(persistSession).toHaveBeenLastCalledWith(expect.objectContaining({
      id: sessionId,
      status: "awaiting_input",
      result: expect.stringContaining("Reviewable plan"),
    }));

    resolveHungPrompt?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptResolvedAfterAbort).toBe(true);
  });
});
