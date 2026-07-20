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
  // FNXC:PlanningMode 2026-07-20-20:15: Agent-backed planning turns resolve the configured prompt lane before emitting the sequential question/plan transition.
  getSettings: vi.fn(async () => ({})),
  listTasks: vi.fn(async () => []),
  getTask: vi.fn(async () => { throw new Error("not found"); }),
} as unknown as TaskStore;

function payload(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "question", data });
}

function completePayload(): string {
  return JSON.stringify({
    type: "complete",
    data: {
      title: "Secure account recovery delivery",
      description: "Build a reviewed recovery workflow with audit coverage.",
      keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
    },
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
  it("delivers planning-clarification metadata that can reopen the exact session", async () => {
    installScriptedAgent([payload(FIRST_QUESTION)]);
    let resolveDelivered: ((message: Record<string, unknown>) => void) | undefined;
    const delivered = new Promise<Record<string, unknown>>((resolve) => {
      resolveDelivered = resolve;
    });
    const messageStore = {
      getInbox: vi.fn(async () => []),
      sendMessage: vi.fn(async (message: Record<string, unknown>) => resolveDelivered?.(message)),
    };
    const sessionId = await createSessionWithAgent(
      "127.0.0.11",
      "Plan mailbox navigation",
      "/tmp/project",
      MOCK_TASK_STORE,
      undefined,
      undefined,
      undefined,
      { clarificationEnabled: true, messageStore: messageStore as never },
    );

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    const message = await delivered;

    expect(message).toMatchObject({
      type: "system",
      content: expect.stringContaining(FIRST_QUESTION.question),
      metadata: {
        kind: "planning-clarification",
        sessionId,
        questionId: FIRST_QUESTION.id,
      },
    });
  });

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
    expect((await getSession(sessionId))?.summary).toMatchObject({
      title: "Secure account recovery delivery",
      keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
    });
    expect((await getSession(sessionId))?.validated).toBe(false);

    const next = await submitResponse(sessionId, {
      [fallbackQuestion.id]: "other",
      _other: "Ask about audit-log security before anything else.",
    }, "/tmp/project", undefined, MOCK_TASK_STORE);
    // FNXC:PlanningMode 2026-07-20-20:15: Answers update the plan only; the next
    // question is user-triggered by refine so a focus can steer it.
    expect(next).toEqual(expect.objectContaining({ type: "complete" }));
    expect((await getSession(sessionId))?.currentQuestion).toBeUndefined();
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
    expect(firstNext.type).toBe("complete");
    expect((await getSession(created.sessionId))?.currentQuestion).toBeUndefined();
    expect(prompts[1]).toContain("Ask me questions about audit logging security instead.");

    const afterCompletion = await getSession(created.sessionId);
    expect(afterCompletion?.validated).toBe(false);
    expect(afterCompletion).not.toHaveProperty("pendingSummary");
    expect(afterCompletion?.summary).toMatchObject({
      title: "Secure account recovery delivery",
      keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
    });
    expect(afterCompletion?.currentQuestion).toBeUndefined();
    expect((await getSession(created.sessionId))?.summary).toBeDefined();
    expect((await getSession(created.sessionId))?.validated).toBe(false);

    const finalPlan = await validateSession(created.sessionId);
    expect(finalPlan.description).toContain("Build a reviewed recovery workflow with audit coverage.");
    expect(await getSession(created.sessionId)).toMatchObject({ validated: true, currentQuestion: undefined });
  });

  it("uses a model-authored initial plan on the non-streaming first turn", async () => {
    const prompts = installScriptedAgent([payload({
      ...FIRST_QUESTION,
      runningPlan: {
        title: "Account recovery implementation plan",
        description: "Deliver a secure, observable recovery experience.",
        keyDeliverables: ["Add recovery token flow", "Test recovery audit events"],
      },
    })]);

    const created = await createSession("127.0.0.13", "Build secure account recovery", MOCK_TASK_STORE, "/tmp/project");
    expect(created.validated).toBe(false);
    expect(created.summary).toMatchObject({
      title: "Account recovery implementation plan",
      description: "Deliver a secure, observable recovery experience.",
      keyDeliverables: ["Add recovery token flow", "Test recovery audit events"],
    });
    expect(prompts[0]).toContain("Create the initial running plan");
    expect(prompts[0]).toContain("Build secure account recovery");
    expect(created.summary.description).not.toBe(created.firstQuestion.question);
  });

  it("uses a model-authored initial plan on the streaming first turn before its question event", async () => {
    installScriptedAgent([payload({
      ...FIRST_QUESTION,
      runningPlan: {
        title: "Streaming account recovery plan",
        description: "Stage a secure recovery flow with observability.",
        keyDeliverables: ["Design recovery token lifecycle", "Test recovery telemetry"],
      },
    })]);
    const sessionId = await createSessionWithAgent(
      "127.0.0.15", "Build secure account recovery", "/tmp/project", MOCK_TASK_STORE,
    );
    const events: string[] = [];
    const firstQuestion = new Promise<void>((resolve) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        events.push(event.type);
        if (event.type === "question") resolve();
      });
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await firstQuestion;

    expect((await getSession(sessionId))?.summary).toMatchObject({
      title: "Streaming account recovery plan",
      description: "Stage a secure recovery flow with observability.",
      keyDeliverables: ["Design recovery token lifecycle", "Test recovery telemetry"],
    });
    expect(events.indexOf("summary")).toBeLessThan(events.indexOf("question"));
  });

  it("recovers a plan-shaped streaming first turn when the model omits runningPlan", async () => {
    installScriptedAgent([payload(FIRST_QUESTION)]);
    const sessionId = await createSessionWithAgent(
      "127.0.0.16", "Build secure account recovery", "/tmp/project", MOCK_TASK_STORE,
    );
    const events: string[] = [];
    const firstQuestion = new Promise<void>((resolve) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        events.push(event.type);
        if (event.type === "question") resolve();
      });
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await firstQuestion;

    const session = await getSession(sessionId);
    expect(session?.summary).toMatchObject({
      title: "Plan: Build secure account recovery",
      description: expect.stringContaining("Plan and deliver Build secure account recovery"),
    });
    expect(session?.summary?.description).not.toBe(FIRST_QUESTION.question);
    expect(session?.summary?.keyDeliverables).not.toEqual([FIRST_QUESTION.question]);
    expect(events.indexOf("summary")).toBeLessThan(events.indexOf("question"));
  });

  it("merges a partial model running-plan update with the prior work product", async () => {
    installScriptedAgent([
      payload({
        ...FIRST_QUESTION,
        runningPlan: {
          title: "Account recovery implementation plan",
          description: "Deliver a secure, observable recovery experience.",
          suggestedSize: "L",
          priority: "high",
          suggestedDependencies: ["Identity service"],
          keyDeliverables: ["Add recovery token flow", "Test recovery audit events"],
        },
      }),
      payload({
        ...SECOND_QUESTION,
        runningPlan: { description: "Deliver a secure recovery experience with a gradual rollout." },
      }),
    ]);

    const created = await createSession("127.0.0.14", "Build secure account recovery", MOCK_TASK_STORE, "/tmp/project");
    await submitResponse(created.sessionId, { scope: "secure" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect((await getSession(created.sessionId))?.summary).toEqual({
      title: "Account recovery implementation plan",
      description: "Deliver a secure recovery experience with a gradual rollout.",
      suggestedSize: "L",
      priority: "high",
      suggestedDependencies: ["Identity service"],
      keyDeliverables: ["Add recovery token flow", "Test recovery audit events"],
    });
  });

  it("keeps fallback running plans answer-aware without turning questions into deliverables", async () => {
    installScriptedAgent([payload(FIRST_QUESTION), payload(SECOND_QUESTION)]);
    const created = await createSession("127.0.0.12", "Build secure account recovery", MOCK_TASK_STORE, "/tmp/project");

    expect(created.summary).toMatchObject({
      title: "Plan: Build secure account recovery",
      description: expect.stringContaining("Plan and deliver Build secure account recovery"),
      keyDeliverables: expect.arrayContaining([
        "Define scope and acceptance criteria for Build secure account recovery",
      ]),
    });

    await submitResponse(created.sessionId, { scope: "secure" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    const session = await getSession(created.sessionId);
    const askedQuestions = session!.history.map((entry) => entry.question.question);
    expect(session?.summary?.description).toContain("Secure defaults");
    expect(session?.summary?.description).not.toBe(session?.currentQuestion?.question);
    expect(session?.summary?.keyDeliverables).toContain("Define scope and acceptance criteria for Build secure account recovery");
    expect(session?.summary?.keyDeliverables).not.toEqual(askedQuestions);
    expect(session?.validated).toBe(false);
  });

  it("replays an edited historical answer into plan review without automatically asking a question", async () => {
    installScriptedAgent([payload(FIRST_QUESTION), completePayload(), completePayload(), completePayload(), completePayload()]);
    const created = await createSession("127.0.0.2", "Improve audit trails", MOCK_TASK_STORE, "/tmp/project");
    await submitResponse(created.sessionId, { scope: "secure" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    await rewindSession(created.sessionId, "scope", "/tmp/project", undefined, MOCK_TASK_STORE);
    const revised = await submitResponse(created.sessionId, { scope: "fast" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    const edited = await getSession(created.sessionId);
    expect(revised.type).toBe("complete");
    expect(edited?.history).toHaveLength(1);
    expect(edited?.history[0]?.response).toEqual({ scope: "fast" });
    expect(edited?.currentQuestion).toBeUndefined();
    expect(edited?.summary).toBeDefined();
  });
});
