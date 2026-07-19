// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  resolveMcpServersForStore: async () => ({ servers: [] }),
  buildSessionSkillContextSync: () => ({ skillSelectionContext: undefined, resolvedSkillNames: [], skillSource: "role-fallback" as const }),
  createFnAgent: vi.fn(),
  createWorkflowAuthoringTools: () => [],
  createChatTaskDocumentTools: () => [],
  createChatTaskLogsReadTool: () => ({}),
}));

import {
  __resetPlanningState,
  __setCreateFnAgent,
  createSession,
  createSessionWithAgent,
  getSession,
  normalizePlanningQuestion,
  planningStreamManager,
  rewindSession,
  submitResponse,
  validateSession,
} from "../planning.js";

const MOCK_TASK_STORE = {
  listTasks: vi.fn(async () => []),
  getTask: vi.fn(async () => { throw new Error("not found"); }),
} as unknown as TaskStore;

function payload(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "question", data });
}

function completePayload(): string {
  return JSON.stringify({
    type: "complete",
    data: { title: "The model tried to end the interview", description: "must be ignored" },
  });
}

/** A scripted planning agent that records every prompt sent through the live session seam. */
function installScriptedAgent(responses: string[]) {
  const prompts: string[] = [];
  __setCreateFnAgent(vi.fn(async () => {
    const messages: Array<{ role: string; content: string }> = [];
    return {
      session: {
        state: { messages },
        prompt: vi.fn(async (message: string) => {
          prompts.push(message);
          const next = responses.shift();
          if (!next) throw new Error(`Unexpected planning prompt: ${message}`);
          messages.push({ role: "assistant", content: next });
        }),
        dispose: vi.fn(),
      },
    };
  }) as never);
  return prompts;
}

const FIRST_QUESTION = {
  id: "scope", type: "single_select", question: "Which outcome matters most?",
  options: [
    { id: "secure", label: "Secure defaults", pros: ["Reduces risk"], cons: ["Takes longer"] },
    { id: "fast", label: "Fast delivery", pros: ["Ships sooner"], cons: ["May defer hardening"] },
    { id: "other", label: "Other (write your own)", isOther: true },
  ],
};

const SECOND_QUESTION = {
  id: "rollout", type: "single_select", question: "How should rollout work?",
  options: [
    { id: "gradual", label: "Gradual rollout", pros: ["Limits blast radius"], cons: ["Needs flags"] },
    { id: "all", label: "All at once", pros: ["Simple release"], cons: ["Higher risk"] },
  ],
};

describe("reactive Planning Mode question contract", () => {
  beforeEach(() => {
    __resetPlanningState();
  });

  it("repairs malformed select options and appends one localized Other option", () => {
    const question = normalizePlanningQuestion({
      id: "security",
      type: "single_select",
      question: "¿Qué prioridad tiene la seguridad?",
      options: [{ id: "fast", label: "Rápido", pros: [], cons: [] }],
    }, "Quiero añadir autenticación para usuarios españoles");

    expect(question.options).toHaveLength(3);
    const alternatives = question.options!.filter((option) => !option.isOther);
    expect(alternatives).toHaveLength(2);
    expect(alternatives.every((option) => option.pros!.length > 0 && option.cons!.length > 0)).toBe(true);
    expect(question.options!.filter((option) => option.isOther)).toEqual([
      expect.objectContaining({ label: "Otro (escribe tu respuesta)", isOther: true }),
    ]);
  });

  it("upgrades legacy text questions so every question has alternatives and Other", () => {
    const question = normalizePlanningQuestion({ type: "text", question: "What matters next?", options: [{ id: "bad" }] });
    expect(question).toEqual(expect.objectContaining({ type: "single_select", question: "What matters next?" }));
    expect(question.options).toHaveLength(3);
    expect(question.options?.at(-1)).toEqual(expect.objectContaining({ isOther: true }));
  });

  /*
  FNXC:PlanningMode 2026-07-18-17:30:
  A model completion is never a Planning Mode terminal state. This exercises the real
  createSession/submitResponse agent seam so regression coverage proves the running plan,
  Other steering, and explicit-only validation invariant rather than only testing normalization.
  */
  it("keeps the streaming agent turn non-terminal after complete, persists its running plan, and validates only on user action", async () => {
    const prompts = installScriptedAgent([
      completePayload(),
      payload(SECOND_QUESTION),
    ]);
    const sessionId = await createSessionWithAgent(
      "127.0.0.10",
      "Build secure account recovery",
      "/tmp/project",
      MOCK_TASK_STORE,
      undefined,
      undefined,
      undefined,
      { clarificationEnabled: true },
    );
    const events: string[] = [];
    const firstQuestion = new Promise<typeof SECOND_QUESTION>((resolve) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        events.push(event.type);
        if (event.type === "question") resolve(event.data as typeof SECOND_QUESTION);
      });
    });
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    const fallbackQuestion = await firstQuestion;

    // The streamed processAgentTurn seam must coerce generic complete output into a question.
    expect(fallbackQuestion.id).not.toBe("complete");
    expect((await getSession(sessionId))?.summary?.description).toContain("Build secure account recovery");
    expect((await getSession(sessionId))?.validated).toBe(false);

    const next = await submitResponse(sessionId, {
      [fallbackQuestion.id]: "other",
      _other: "Ask about audit-log security before anything else.",
    }, "/tmp/project", undefined, MOCK_TASK_STORE);
    expect(next).toEqual(expect.objectContaining({ type: "question", data: expect.objectContaining({ id: "rollout" }) }));
    expect(prompts.at(-1)).toContain("Ask about audit-log security before anything else.");
    expect(events.filter((type) => type === "summary")).toHaveLength(2);

    await validateSession(sessionId);
    expect(await getSession(sessionId)).toMatchObject({ validated: true, currentQuestion: undefined });
  });

  it("continues after a model completion with a running plan and only validates on user action", async () => {
    const prompts = installScriptedAgent([
      payload(FIRST_QUESTION),
      completePayload(),
      payload(SECOND_QUESTION),
    ]);
    const created = await createSession("127.0.0.1", "Build secure account recovery", MOCK_TASK_STORE, "/tmp/project");

    expect(created.summary.description).toContain("Build secure account recovery");
    expect(created.validated).toBe(false);
    expect((await getSession(created.sessionId))?.currentQuestion?.id).toBe("scope");

    const firstNext = await submitResponse(created.sessionId, {
      scope: "other",
      _other: "Ask me questions about audit logging security instead.",
    }, "/tmp/project", undefined, MOCK_TASK_STORE);
    expect(firstNext.type).toBe("question");
    expect(firstNext.data.id).not.toBe("scope");
    expect(prompts[1]).toContain("Ask me questions about audit logging security instead.");

    const afterCompletion = await getSession(created.sessionId);
    expect(afterCompletion?.validated).toBe(false);
    expect(afterCompletion).not.toHaveProperty("pendingSummary");
    expect(afterCompletion?.summary?.description).toContain("audit logging security");
    expect(afterCompletion?.currentQuestion).toBeDefined();

    const secondQuestion = afterCompletion!.currentQuestion!;
    const secondNext = await submitResponse(created.sessionId, { [secondQuestion.id]: "option-1" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    expect(secondNext).toEqual(expect.objectContaining({ type: "question" }));
    expect((await getSession(created.sessionId))?.summary).toBeDefined();
    expect((await getSession(created.sessionId))?.validated).toBe(false);

    const finalPlan = await validateSession(created.sessionId);
    expect(finalPlan.description).toContain("Build secure account recovery");
    expect(await getSession(created.sessionId)).toMatchObject({ validated: true, currentQuestion: undefined });
  });

  it("replays an edited historical answer while retaining later answers and appending a fresh question", async () => {
    installScriptedAgent([
      payload(FIRST_QUESTION),
      payload(SECOND_QUESTION),
      payload({ ...SECOND_QUESTION, id: "verification", question: "What verification is required?" }),
      payload({ ...SECOND_QUESTION, id: "ignored-replay" }),
      payload({ ...SECOND_QUESTION, id: "ignored-replay-after-edit" }),
      payload({ ...SECOND_QUESTION, id: "fresh-after-edit", question: "What risk remains after the edit?" }),
    ]);
    const created = await createSession("127.0.0.2", "Improve audit trails", MOCK_TASK_STORE, "/tmp/project");
    await submitResponse(created.sessionId, { scope: "secure" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    const second = (await getSession(created.sessionId))!.currentQuestion!;
    await submitResponse(created.sessionId, { [second.id]: "gradual" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    await rewindSession(created.sessionId, "scope", "/tmp/project", undefined, MOCK_TASK_STORE);
    await submitResponse(created.sessionId, { scope: "fast" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    const edited = await getSession(created.sessionId);
    expect(edited?.history).toHaveLength(2);
    expect(edited?.history[0]?.response).toEqual({ scope: "fast" });
    expect(edited?.history[1]?.response).toEqual({ [second.id]: "gradual" });
    expect(edited?.currentQuestion?.id).toBe("fresh-after-edit");
    expect(edited?.summary?.description).toContain("fast");
  });
});
