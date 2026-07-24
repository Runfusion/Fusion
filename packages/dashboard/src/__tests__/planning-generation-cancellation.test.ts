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

  /*
  FNXC:PlanningStopMultiSession 2026-07-23-23:50:
  Stop must cancel a session whose initial turn is still PENDING (start-streaming registered
  it, but no stream connect consumed it yet) and must never touch other sessions' generations.
  Previously stop returned false here and the "stopped" turn sprang back to life on the next
  stream connect.
  */
  it("cancels a pending initial turn and leaves other sessions' generations untouched", async () => {
    const prompt = vi.fn(async () => {});
    __setCreateFnAgent(vi.fn(async () => ({
      session: { state: { messages: [] }, prompt, dispose: vi.fn() },
    })) as any);

    const stoppedSessionId = await createSessionWithAgent(
      "10.0.2.11",
      "Plan that gets stopped before its stream connects",
      "/tmp/project",
      MOCK_TASK_STORE,
    );
    const survivorSessionId = await createSessionWithAgent(
      "10.0.2.12",
      "Plan that keeps generating",
      "/tmp/project",
      MOCK_TASK_STORE,
    );

    expect(planningStreamManager.hasPendingInitialTurn(stoppedSessionId)).toBe(true);
    expect(stopGeneration(stoppedSessionId)).toBe(true);

    // The discarded turn must not fire on a later stream connect.
    expect(planningStreamManager.hasPendingInitialTurn(stoppedSessionId)).toBe(false);
    expect(planningStreamManager.consumeInitialTurn(stoppedSessionId)).toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();

    // The other session's pending turn is untouched and still runs normally.
    expect(planningStreamManager.hasPendingInitialTurn(survivorSessionId)).toBe(true);
    planningStreamManager.consumeInitialTurn(survivorSessionId)?.();
    for (let i = 0; i < 20 && prompt.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(prompt).toHaveBeenCalled();
  });
});
