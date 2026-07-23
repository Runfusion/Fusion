// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  __setPlanningNtfyHelpers,
  createSession,
  createSessionWithAgent,
  formatInitialRunningPlanRequestForAgent,
  formatContextualCommentsForAgent,
  formatResponseForAgent,
  getSession,
  normalizePlanningSummaryPayload,
  normalizePlanningQuestion,
  PLANNING_SYSTEM_PROMPT,
  planningStreamManager,
  retrySession,
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

/** System prompts used by agent constructions in the current test. */
let agentSystemPrompts: string[] = [];

/** A scripted planning agent that records every prompt sent through the live session seam. */
function installScriptedAgent(responses: string[]) {
  const prompts: string[] = [];
  __setCreateFnAgent(vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
    agentSystemPrompts.push(systemPrompt);
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

const BACKGROUND_DIRECTIONS = {
  id: "background-direction", type: "single_select", question: "Which background direction should the dashboard take?",
  description: "Repository inspection found the dashboard's shared background tokens and visual-effects surface.",
  options: [
    { id: "change-color", label: "Change the background color", pros: ["Keeps rendering simple"], cons: ["Adds little depth"] },
    { id: "add-effects", label: "Add effects to the background", pros: ["Creates a distinctive atmosphere"], cons: ["Needs performance guardrails"] },
    { id: "other", label: "Other (write your own)", isOther: true },
  ],
};

const EFFECT_TYPES = {
  id: "effect-type", type: "single_select", question: "What type of background effects should we add?",
  options: [
    { id: "3d", label: "3D effects", pros: ["Adds spatial depth"], cons: ["Can increase GPU work"] },
    { id: "light", label: "Light effects", pros: ["Keeps the interface subtle"], cons: ["May be less dramatic"] },
    { id: "other", label: "Other (write your own)", isOther: true },
  ],
};

const EFFECT_INTENSITY = {
  id: "effect-intensity", type: "single_select", question: "How prominent should the selected light effects be?",
  options: [
    { id: "subtle", label: "Subtle ambient light", pros: ["Protects readability"], cons: ["Has a quieter visual impact"] },
    { id: "expressive", label: "Expressive animated light", pros: ["Makes the background more visible"], cons: ["Needs motion safeguards"] },
    { id: "other", label: "Other (write your own)", isOther: true },
  ],
};

describe("reactive Planning Mode question contract", () => {
  beforeEach(() => {
    __resetPlanningState();
    agentSystemPrompts = [];
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

  it("formats contextual comments in order with their selected quotes", () => {
    const message = formatContextualCommentsForAgent({
      title: "Recovery plan",
      description: "Keep accounts recoverable.",
      keyDeliverables: [],
      suggestedRefinements: [],
    }, [
      { quote: "Add audit events", suggestion: "Specify retention." },
      { quote: "Deploy safely", suggestion: "Use a staged rollout." },
    ]);

    expect(message).toContain("1. Selected quote: Add audit events");
    expect(message).toContain("Suggestion: Specify retention.");
    expect(message.indexOf("Add audit events")).toBeLessThan(message.indexOf("Deploy safely"));
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
    expect(prompts.at(-1)).toMatch(/ask exactly one next question/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/Proceed with plan serializes the plan as plan\.md/i);
  });

  it("defines a collaborative selection-led narrowing contract rather than an execution-task specification", () => {
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/investigate relevant repository and active-board context/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/assumptions, unknowns, constraints/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/Compare viable approaches and their trade-offs/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/Discuss decomposition/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/concrete deliverables.*observable acceptance criteria/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/not an executor-ready task specification/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/do not automatically split work/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/Do not produce task-specification bookkeeping.*commit guidance.*no-code-change caveats.*task-creation directives/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/vague, subjective, preference-based, or symptom-only/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/materially distinct actionable directions/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/durable decision/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/selected direction—not the original vague complaint or an unselected alternative—the central intended outcome/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/narrows it one level further/i);
    expect(PLANNING_SYSTEM_PROMPT).toMatch(/respond only with JSON/i);
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
  FNXC:PlanningMode 2026-07-21-09:15:
  Planning questions belong to the planning surface. Exercise both the initial and follow-up
  streaming/non-streaming seams so neither can duplicate its question in the dashboard user's mailbox, while configured ntfy notifications remain available outside the planning view.
  */
  it("keeps initial and follow-up questions out of Mailbox while preserving ntfy", async () => {
    installScriptedAgent([
      payload({
        ...FIRST_QUESTION,
        runningPlan: {
          title: "Secure account recovery delivery",
          description: "Build a reviewed recovery workflow with audit coverage.",
          keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
        },
      }),
      payload({
        ...SECOND_QUESTION,
        runningPlan: {
          title: "Secure account recovery delivery",
          description: "Build a reviewed recovery workflow with audit coverage.",
          keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
        },
      }),
    ]);
    const messageStore = {
      getInbox: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    };
    let notificationCount = 0;
    let resolveNotifications!: () => void;
    const notificationsDelivered = new Promise<void>((resolveNotificationsPromise) => {
      resolveNotifications = resolveNotificationsPromise;
    });
    const sendNtfyNotification = vi.fn(async () => {
      notificationCount += 1;
      if (notificationCount === 2) resolveNotifications();
    });
    __setPlanningNtfyHelpers({
      isNtfyEventEnabled: () => true,
      buildNtfyClickUrl: () => "http://localhost/planning",
      sendNtfyNotification,
    });
    const created = await createSession(
      "127.0.0.11",
      "Plan mailbox navigation",
      MOCK_TASK_STORE,
      "/tmp/project",
      undefined,
      undefined,
      {
        clarificationEnabled: true,
        messageStore: messageStore as never,
        ntfyConfig: { enabled: true, topic: "planning-tests", events: ["planning-awaiting-input"] },
      },
    );
    await submitResponse(created.sessionId, { scope: "secure" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    await notificationsDelivered;

    expect((await getSession(created.sessionId))?.currentQuestion?.id).toBe(SECOND_QUESTION.id);
    expect(messageStore.getInbox).not.toHaveBeenCalled();
    expect(messageStore.sendMessage).not.toHaveBeenCalled();
    expect(sendNtfyNotification).toHaveBeenCalledTimes(2);
  });

  it("keeps streamed initial and follow-up questions out of Mailbox", async () => {
    installScriptedAgent([
      payload({ ...FIRST_QUESTION, runningPlan: normalizePlanningSummaryPayload({ title: "Streaming plan", description: "Initial plan" }) }),
      payload({ ...SECOND_QUESTION, runningPlan: normalizePlanningSummaryPayload({ title: "Streaming plan", description: "Updated plan" }) }),
    ]);
    const messageStore = {
      getInbox: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    };
    const sessionId = await createSessionWithAgent(
      "127.0.0.12",
      "Plan streaming mailbox silence",
      "/tmp/project",
      MOCK_TASK_STORE,
      undefined,
      undefined,
      undefined,
      { clarificationEnabled: true, messageStore },
    );
    const initialQuestionReady = new Promise<void>((resolveQuestion) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        if (event.type === "question") resolveQuestion();
      });
    });
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await initialQuestionReady;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    await submitResponse(sessionId, { scope: "secure" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect((await getSession(sessionId))?.currentQuestion?.id).toBe(SECOND_QUESTION.id);
    expect(messageStore.getInbox).not.toHaveBeenCalled();
    expect(messageStore.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps planning route and session sources free of mailbox delivery wiring", () => {
    const planningSource = readFileSync(resolve(__dirname, "..", "planning.ts"), "utf8");
    const planningRoutesSource = readFileSync(resolve(__dirname, "..", "routes", "register-planning-subtask-routes.ts"), "utf8");

    expect(planningSource).not.toMatch(/\.(?:getInbox|sendMessage)\(/);
    expect(planningRoutesSource).not.toMatch(/\bMessageStore\b|getMessageStore\(/);
  });

  /*
  FNXC:PlanningMode 2026-07-18-17:30:
  A model completion is never a Planning Mode terminal state. This exercises the real
  createSession/submitResponse agent seam so regression coverage proves the running plan,
  Other steering, and explicit-only validation invariant rather than only testing normalization.
  */
  it("generates a durable initial plan with one question and validates only on user action", async () => {
    const prompts = installScriptedAgent([
      payload({
        ...SECOND_QUESTION,
        runningPlan: {
          title: "Secure account recovery delivery",
          description: "Build a reviewed recovery workflow with audit coverage.",
          proposedChanges: ["Add recovery-token lifecycle handling", "Expose recovery audit events"],
          acceptanceCriteria: ["Users can recover accounts securely", "Every recovery attempt is auditable"],
          keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
          suggestedRefinements: ["Security boundaries", "Rollout strategy", "Failure recovery"],
        },
      }),
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
    expect((await getSession(sessionId))?.currentQuestion?.id).toBe("rollout");
    expect((await getSession(sessionId))?.validated).toBe(false);
    expect(events).toContain("question");
    expect(prompts[0]).toContain("initial implementation plan");

    await validateSession(sessionId);
    expect(await getSession(sessionId)).toMatchObject({ validated: true, currentQuestion: undefined });
  });

  it("submits contextual comments through the existing plan-update session seam", async () => {
    const prompts = installScriptedAgent([
      payload(FIRST_QUESTION),
      payload(SECOND_QUESTION),
    ]);
    const created = await createSession("127.0.0.18", "Build secure account recovery", MOCK_TASK_STORE, "/tmp/project");

    await submitResponse(created.sessionId, {
      contextualComments: [
        { quote: "Use audit logs", suggestion: "Define retention." },
        { quote: "Ship safely", suggestion: "Add a staged rollout." },
      ],
    }, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect(prompts.at(-1)).toContain("Use audit logs");
    expect(prompts.at(-1)).toContain("Add a staged rollout.");
    expect(prompts.at(-1)!.indexOf("Use audit logs")).toBeLessThan(prompts.at(-1)!.indexOf("Ship safely"));
  });

  it("replays a failed contextual batch when the session is retried", async () => {
    const prompts = installScriptedAgent([
      payload(FIRST_QUESTION),
      "not valid planning JSON",
      "still not valid planning JSON",
      payload(SECOND_QUESTION),
    ]);
    const created = await createSession("127.0.0.19", "Build secure account recovery", MOCK_TASK_STORE, "/tmp/project");
    const contextualComments = [
      { quote: "Use audit logs", suggestion: "Define retention." },
      { quote: "Ship safely", suggestion: "Add a staged rollout." },
    ];

    await submitResponse(created.sessionId, { contextualComments }, "/tmp/project", undefined, MOCK_TASK_STORE);
    expect((await getSession(created.sessionId))?.pendingContextualComments).toEqual(contextualComments);

    await retrySession(created.sessionId, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain("Use audit logs");
    expect(prompts[3]).toContain("Use audit logs");
    expect(prompts[3]).toContain("Add a staged rollout.");
    expect(agentSystemPrompts).toEqual([PLANNING_SYSTEM_PROMPT, PLANNING_SYSTEM_PROMPT]);
    expect((await getSession(created.sessionId))?.pendingContextualComments).toBeUndefined();
  });

  it("uses Refine to replace the active question without recording a fake answer", async () => {
    const prompts = installScriptedAgent([
      payload(FIRST_QUESTION),
      payload(SECOND_QUESTION),
    ]);
    const created = await createSession("127.0.0.18", "Build secure account recovery", MOCK_TASK_STORE, "/tmp/project");

    const refined = await submitResponse(created.sessionId, {
      refine: true,
      focus: "Rollout safety, observability",
    }, "/tmp/project", undefined, MOCK_TASK_STORE);

    expect(refined).toEqual(expect.objectContaining({ type: "question", data: expect.objectContaining({ id: "rollout" }) }));
    expect((await getSession(created.sessionId))?.history).toEqual([]);
    expect(prompts.at(-1)).toContain("Rollout safety, observability");
  });

  it("continues after a model completion with a running plan and only validates on user action", async () => {
    const prompts = installScriptedAgent([
      payload(FIRST_QUESTION),
      payload({
        ...SECOND_QUESTION,
        runningPlan: {
          title: "Secure account recovery delivery",
          description: "Build a reviewed recovery workflow with audit coverage.",
          keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
        },
      }),
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
    expect((await getSession(created.sessionId))?.currentQuestion?.id).toBe("rollout");
    expect(prompts[1]).toContain("Ask me questions about audit logging security instead.");

    const afterCompletion = await getSession(created.sessionId);
    expect(afterCompletion?.validated).toBe(false);
    expect(afterCompletion).not.toHaveProperty("pendingSummary");
    expect(afterCompletion?.summary).toMatchObject({
      title: "Secure account recovery delivery",
      keyDeliverables: ["Implement recovery workflow", "Verify audit coverage"],
    });
    expect(afterCompletion?.currentQuestion?.id).toBe("rollout");
    expect((await getSession(created.sessionId))?.summary).toBeDefined();
    expect((await getSession(created.sessionId))?.validated).toBe(false);

    const finalPlan = await validateSession(created.sessionId);
    expect(finalPlan.description).toContain("Build a reviewed recovery workflow with audit coverage.");
    expect(await getSession(created.sessionId)).toMatchObject({ validated: true, currentQuestion: undefined });
  });

  it("rebuilds a non-streaming vague-background plan around successive selected directions", async () => {
    installScriptedAgent([
      payload({
        ...BACKGROUND_DIRECTIONS,
        runningPlan: {
          title: "Improve dashboard background direction",
          description: "Evaluate the inspected shared background surfaces before choosing a color change or visual effects.",
          proposedChanges: ["Inspect shared background tokens and effects surfaces"],
          acceptanceCriteria: ["The selected direction is reflected in the plan"],
          keyDeliverables: ["Choose a background direction"],
        },
      }),
      payload({
        ...EFFECT_TYPES,
        runningPlan: {
          title: "Add effects to the dashboard background",
          description: "Add visual effects to the dashboard background instead of changing its color.",
          proposedChanges: ["Add performant background effects to the shared dashboard surface"],
          acceptanceCriteria: ["The dashboard background renders the chosen effects without replacing its color strategy"],
          keyDeliverables: ["Implement background effects", "Verify background-effect performance"],
        },
      }),
      payload({
        ...EFFECT_INTENSITY,
        runningPlan: {
          title: "Add light effects to the dashboard background",
          description: "Add light effects to the dashboard background with the selected effects direction retained.",
          proposedChanges: ["Add light-based background effects to the shared dashboard surface"],
          acceptanceCriteria: ["Light effects render without a color-change implementation"],
          keyDeliverables: ["Implement light background effects", "Verify light-effect performance"],
        },
      }),
    ]);

    const created = await createSession("127.0.0.31", "I don't like the black background", MOCK_TASK_STORE, "/tmp/project");
    expect(created.firstQuestion).toMatchObject({ id: "background-direction" });
    expect(created.firstQuestion.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Change the background color" }),
      expect.objectContaining({ label: "Add effects to the background" }),
    ]));
    expect(created.summary.description).toContain("before choosing a color change or visual effects");

    await submitResponse(created.sessionId, { "background-direction": "add-effects" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    let session = await getSession(created.sessionId);
    expect(session?.summary).toMatchObject({
      title: "Add effects to the dashboard background",
      description: expect.stringContaining("instead of changing its color"),
      proposedChanges: ["Add performant background effects to the shared dashboard surface"],
      keyDeliverables: ["Implement background effects", "Verify background-effect performance"],
    });
    expect(session?.currentQuestion).toMatchObject({ id: "effect-type", question: expect.stringMatching(/type of background effects/i) });
    expect(session?.currentQuestion?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "3D effects" }),
      expect.objectContaining({ label: "Light effects" }),
    ]));

    await submitResponse(created.sessionId, { "effect-type": "light" }, "/tmp/project", undefined, MOCK_TASK_STORE);
    session = await getSession(created.sessionId);
    expect(session?.summary).toMatchObject({
      title: "Add light effects to the dashboard background",
      description: expect.stringContaining("selected effects direction retained"),
      proposedChanges: ["Add light-based background effects to the shared dashboard surface"],
    });
    expect(session?.summary?.description).not.toContain("Change the background color");
    expect(session?.history).toHaveLength(2);
    expect(session?.currentQuestion).toMatchObject({ id: "effect-intensity" });
    expect(session?.validated).toBe(false);
  });

  it("persists the same selected-direction plan through streaming session recreation", async () => {
    installScriptedAgent([
      payload({ ...BACKGROUND_DIRECTIONS, runningPlan: { title: "Improve dashboard background direction", description: "Choose a repository-grounded dashboard background direction.", keyDeliverables: ["Choose a background direction"] } }),
      payload({ ...EFFECT_TYPES, runningPlan: { title: "Add effects to the dashboard background", description: "Add effects to the background after the operator selected that direction.", proposedChanges: ["Add background effects"], keyDeliverables: ["Implement background effects"] } }),
    ]);
    const sessionId = await createSessionWithAgent("127.0.0.32", "I don't like the black background", "/tmp/project", MOCK_TASK_STORE);
    const initialQuestionReady = new Promise<void>((resolveQuestion) => {
      planningStreamManager.subscribe(sessionId, (event) => {
        if (event.type === "question") resolveQuestion();
      });
    });
    planningStreamManager.consumeInitialTurn(sessionId)?.();
    await initialQuestionReady;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    await submitResponse(sessionId, { "background-direction": "add-effects" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    const session = await getSession(sessionId);
    expect(session?.summary).toMatchObject({
      title: "Add effects to the dashboard background",
      description: expect.stringContaining("operator selected that direction"),
      proposedChanges: ["Add background effects"],
    });
    expect(session?.history).toEqual([expect.objectContaining({ response: { "background-direction": "add-effects" } })]);
    expect(session?.currentQuestion).toMatchObject({ id: "effect-type" });
    expect(agentSystemPrompts).toEqual([PLANNING_SYSTEM_PROMPT]);
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

  it("uses the dedicated prompt in both initial and streaming agent creation paths", async () => {
    const systemPrompts: string[] = [];
    __setCreateFnAgent(vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
      systemPrompts.push(systemPrompt);
      const messages: Array<{ role: string; content: string }> = [];
      return {
        session: {
          state: { messages },
          prompt: vi.fn(async () => {
            messages.push({ role: "assistant", content: payload({ ...FIRST_QUESTION, runningPlan: normalizePlanningSummaryPayload({ title: "Dedicated prompt plan" }) }) });
          }),
          dispose: vi.fn(),
        },
      };
    }) as never);
    const leakingStore = {
      ...MOCK_TASK_STORE,
      getSettings: vi.fn(async () => ({
        agentPrompts: {
          roleAssignments: { triage: "execution-triage" },
          templates: [{ id: "execution-triage", role: "triage", prompt: "PROMPT.md NO-CODE CREATE CHILD TASK" }],
        },
      })),
    } as unknown as TaskStore;

    await createSession("127.0.0.21", "Plan a safer sign-in flow", leakingStore, "/tmp/project");
    const streamingSessionId = await createSessionWithAgent(
      "127.0.0.22", "Plan a safer sign-in flow", "/tmp/project", leakingStore,
      undefined, undefined, undefined, { workflowId: "WF-custom" },
    );
    planningStreamManager.consumeInitialTurn(streamingSessionId)?.();
    await vi.waitFor(() => expect(systemPrompts).toHaveLength(2));

    for (const systemPrompt of systemPrompts) {
      expect(systemPrompt).toBe(PLANNING_SYSTEM_PROMPT);
      expect(systemPrompt).not.toContain("PROMPT.md NO-CODE CREATE CHILD TASK");
      expect(systemPrompt).toContain('"type":"question"');
    }
  });

  it("uses a model-authored initial plan on the streaming first turn and exposes one question", async () => {
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
    expect(events).toContain("question");
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
    expect(events).toContain("question");
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

  it("replays an edited historical answer and asks the next question", async () => {
    installScriptedAgent([payload(FIRST_QUESTION), completePayload(), completePayload(), completePayload(), completePayload()]);
    const created = await createSession("127.0.0.2", "Improve audit trails", MOCK_TASK_STORE, "/tmp/project");
    await submitResponse(created.sessionId, { scope: "secure" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    await rewindSession(created.sessionId, "scope", "/tmp/project", undefined, MOCK_TASK_STORE);
    const revised = await submitResponse(created.sessionId, { scope: "fast" }, "/tmp/project", undefined, MOCK_TASK_STORE);

    const edited = await getSession(created.sessionId);
    expect(revised.type).toBe("question");
    expect(edited?.history).toHaveLength(1);
    expect(edited?.history[0]?.response).toEqual({ scope: "fast" });
    expect(edited?.currentQuestion).toBeDefined();
    expect(edited?.summary).toBeDefined();
  });
});
