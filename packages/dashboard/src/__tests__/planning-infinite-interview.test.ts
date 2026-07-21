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
  formatInitialRunningPlanRequestForAgent,
  formatResponseForAgent,
  getSession,
  normalizePlanningSummaryPayload,
  normalizePlanningQuestion,
  PLANNING_SYSTEM_PROMPT,
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
      proposedChanges: ["Add recovery-token lifecycle handling", "Expose recovery audit events"],
      acceptanceCriteria: ["Users can recover accounts securely", "Every recovery attempt is auditable"],
      keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
      suggestedRefinements: ["Security boundaries", "Rollout strategy", "Failure recovery"],
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

  it("preserves every valid suggested refinement category", () => {
    const refinementCategories = [
      "Security boundaries",
      "Rollout strategy",
      "Failure recovery",
      "Accessibility",
      "Observability",
    ];

    const summary = normalizePlanningSummaryPayload({
      title: "A plan",
      description: "A description",
      suggestedSize: "M",
      suggestedDependencies: [],
      keyDeliverables: [],
      suggestedRefinements: refinementCategories,
    });

    expect(summary.suggestedRefinements).toEqual(refinementCategories);
  });

  it("asks the model for all high-value categories without a three-category cap", () => {
    const prompts = [
      PLANNING_SYSTEM_PROMPT,
      formatInitialRunningPlanRequestForAgent("Build secure accounts"),
      formatResponseForAgent(FIRST_QUESTION, { scope: "secure" }),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/exactly three/i);
      expect(prompt).toMatch(/do not cap[^.]*three/i);
    }
  });

  it("asks for an operator-facing plan in Markdown at every plan-writing boundary", () => {
    const prompts = [
      PLANNING_SYSTEM_PROMPT,
      formatInitialRunningPlanRequestForAgent("Build secure accounts"),
      formatResponseForAgent(FIRST_QUESTION, { scope: "secure" }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toMatch(/plan in Markdown/i);
    }
    expect(prompts.at(-1)).toMatch(/without asking another question/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/Proceed with plan serializes the plan as plan\.md/i);
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

  it("deduplicates a model-authored Other option before appending the canonical one", () => {
    const question = normalizePlanningQuestion({
      id: "security",
      type: "single_select",
      question: "What matters most?",
      options: [
        { id: "safe", label: "Safe defaults" },
        { id: "fast", label: "Fast delivery" },
        { id: "other", label: "Other (write your own)" },
      ],
    });

    expect(question.options?.filter((option) => option.id === "other" || option.isOther)).toHaveLength(1);
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
    installScriptedAgent([completePayload(), payload(FIRST_QUESTION)]);
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

    const initialPlanReady = new Promise<void>((resolve) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        if (event.type === "summary") resolve();
      });
    });
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await initialPlanReady;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await submitResponse(sessionId, { refine: true, focus: "Security boundaries" }, "/tmp/project", undefined, MOCK_TASK_STORE);
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

  it("generates a durable initial plan before any question and validates only on user action", async () => {
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
    const initialPlanReady = new Promise<void>((resolve) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        events.push(event.type);
        if (event.type === "summary") resolve();
      });
    });
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await initialPlanReady;

    expect((await getSession(sessionId))?.summary).toMatchObject({
      title: "Secure account recovery delivery",
      keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
      suggestedRefinements: ["Security boundaries", "Rollout strategy", "Failure recovery"],
    });
    expect((await getSession(sessionId))?.currentQuestion).toBeUndefined();
    expect((await getSession(sessionId))?.validated).toBe(false);
    expect(events).not.toContain("question");
    expect(prompts[0]).toContain("initial implementation plan");

    const refine = await submitResponse(sessionId, {
      refine: true,
      focus: "Security boundaries",
    }, "/tmp/project", undefined, MOCK_TASK_STORE);
    expect(refine).toEqual(expect.objectContaining({ type: "question" }));
    expect(prompts.at(-1)).toContain("Security boundaries");

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

  it("uses a model-authored initial plan on the streaming first turn without exposing its question", async () => {
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
    const initialPlanReady = new Promise<void>((resolve) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        events.push(event.type);
        if (event.type === "summary") resolve();
      });
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await initialPlanReady;

    expect((await getSession(sessionId))?.summary).toMatchObject({
      title: "Streaming account recovery plan",
      description: "Stage a secure recovery flow with observability.",
      keyDeliverables: ["Design recovery token lifecycle", "Test recovery telemetry"],
    });
    expect(events).not.toContain("question");
  });

  it("recovers a plan-shaped streaming first turn when the model omits runningPlan", async () => {
    installScriptedAgent([payload(FIRST_QUESTION)]);
    const sessionId = await createSessionWithAgent(
      "127.0.0.16", "Build secure account recovery", "/tmp/project", MOCK_TASK_STORE,
    );
    const events: string[] = [];
    const initialPlanReady = new Promise<void>((resolve) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        events.push(event.type);
        if (event.type === "summary") resolve();
      });
    });

    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await initialPlanReady;

    const session = await getSession(sessionId);
    expect(session?.summary).toMatchObject({
      title: "Plan: Build secure account recovery",
      description: expect.stringContaining("Plan and deliver Build secure account recovery"),
    });
    expect(session?.summary?.description).not.toBe(FIRST_QUESTION.question);
    expect(session?.summary?.keyDeliverables).not.toEqual([FIRST_QUESTION.question]);
    expect(events).not.toContain("question");
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
      proposedChanges: ["Change the affected workflow to support: Build secure account recovery"],
      acceptanceCriteria: ["The requested outcome works end to end for: Build secure account recovery"],
      suggestedDependencies: ["Identity service"],
      keyDeliverables: ["Add recovery token flow", "Test recovery audit events"],
      suggestedRefinements: ["Scope and user experience", "Technical approach and integration", "Validation and rollout"],
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
