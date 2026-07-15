import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateFnAgent, mockResolveMcpServersForStore } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
  mockResolveMcpServersForStore: vi.fn(async () => ({ servers: [], errors: [] })),
}));

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  buildSessionSkillContextSync: (_agent: unknown, sessionPurpose: string, projectRootDir: string, pluginRunner?: { getPluginSkills?: () => Array<{ pluginId: string; skill: { name: string; enabled?: boolean } }> }) => {
    const requestedSkillNames = ["fusion"];
    for (const contribution of pluginRunner?.getPluginSkills?.() ?? []) {
      const name = contribution.skill.name.trim();
      if (contribution.skill.enabled === false || name.length === 0 || requestedSkillNames.includes(name)) {
        continue;
      }
      requestedSkillNames.push(name);
    }
    return {
      skillSelectionContext: { projectRootDir, requestedSkillNames, sessionPurpose },
      resolvedSkillNames: requestedSkillNames,
      skillSource: "role-fallback" as const,
    };
  },
  createFnAgent: mockCreateFnAgent,
  resolveMcpServersForStore: mockResolveMcpServersForStore,
}));

import {
  __resetAgentOnboardingState,
  agentOnboardingStreamManager,
  cancelAgentOnboardingSession,
  createAgentOnboardingSessionPrompt,
  getAgentOnboardingSession,
  getAgentOnboardingSummary,
  InvalidSessionStateError,
  parseAgentOnboardingResponse,
  respondToAgentOnboarding,
  retryAgentOnboardingSession,
  SessionNotFoundError,
  startAgentOnboardingSession,
} from "../agent-onboarding.js";

function createMockAgent(responses: string[]) {
  const queue = [...responses];
  const messages: Array<{ role: string; content: string }> = [];
  return {
    session: {
      state: { messages },
      prompt: vi.fn(async () => {
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

/*
FNXC:AgentOnboarding 2026-07-15-14:32:
Recovery regressions must await the onboarding event seam rather than poll wall-clock session state. Buffered-event replay covers generations that complete before the test subscribes.
*/
function waitForOnboardingEvent(sessionId: string, eventTypes: string[]): Promise<void> {
  if (agentOnboardingStreamManager.getBufferedEvents(sessionId, 0).some((event) => eventTypes.includes(event.event))) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsubscribe = agentOnboardingStreamManager.subscribe(sessionId, (event) => {
      if (!eventTypes.includes(event.type)) return;
      unsubscribe();
      resolve();
    });
  });
}

function createSkillPluginRunner(skills: Array<{ name: string; enabled?: boolean }>) {
  return {
    getPluginSkills: () => skills.map((skill) => ({ pluginId: "fusion-plugin-compound-engineering", skill })),
  };
}

describe("agent-onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveMcpServersForStore.mockResolvedValue({ servers: [], errors: [] });
    __resetAgentOnboardingState();
  });

  afterEach(() => {
    __resetAgentOnboardingState();
  });

  it("parses question responses", () => {
    const parsed = parseAgentOnboardingResponse(
      JSON.stringify({
        type: "question",
        data: {
          id: "q1",
          type: "text",
          question: "What should this agent focus on?",
        },
      }),
    );

    expect(parsed.type).toBe("question");
    if (parsed.type === "question") {
      expect(parsed.data.id).toBe("q1");
    }
  });

  it("parses complete summary responses with rich optional draft fields", () => {
    const parsed = parseAgentOnboardingResponse(
      JSON.stringify({
        type: "complete",
        data: {
          name: "Docs Reviewer",
          role: "reviewer",
          instructionsText: "Review docs for clarity and accuracy.",
          thinkingLevel: "medium",
          maxTurns: 20,
          soul: "Calm and thorough",
          memory: "Remember docs conventions",
          heartbeatProcedurePath: "  .fusion/agents/docs-reviewer/HEARTBEAT.md  ",
          heartbeatIntervalMs: 30000,
          heartbeatEnabled: true,
          modelHint: "anthropic/claude-sonnet-4-5",
          runtimeHint: "openclaw",
        },
      }),
    );

    expect(parsed.type).toBe("complete");
    if (parsed.type === "complete") {
      expect(parsed.data.name).toBe("Docs Reviewer");
      expect(parsed.data.maxTurns).toBe(20);
      expect(parsed.data.heartbeatProcedurePath).toBe(".fusion/agents/docs-reviewer/HEARTBEAT.md");
      expect(parsed.data.heartbeatIntervalMs).toBe(30000);
      expect(parsed.data.heartbeatEnabled).toBe(true);
      expect(parsed.data.modelHint).toBe("anthropic/claude-sonnet-4-5");
      expect(parsed.data.runtimeHint).toBe("openclaw");
    }
  });

  it("parses legacy complete summaries without rich draft fields", () => {
    const parsed = parseAgentOnboardingResponse(
      JSON.stringify({
        type: "complete",
        data: {
          name: "Legacy Reviewer",
          role: "reviewer",
          instructionsText: "Review old style drafts",
          thinkingLevel: "low",
          maxTurns: 10,
        },
      }),
    );

    expect(parsed.type).toBe("complete");
    if (parsed.type === "complete") {
      expect(parsed.data.name).toBe("Legacy Reviewer");
      expect(parsed.data.heartbeatProcedurePath).toBeUndefined();
      expect(parsed.data.modelHint).toBeUndefined();
      expect(parsed.data.runtimeHint).toBeUndefined();
    }
  });

  it("rejects invalid complete summary", () => {
    expect(() =>
      parseAgentOnboardingResponse(
        JSON.stringify({
          type: "complete",
          data: {
            name: "",
            role: "reviewer",
            instructionsText: "",
            thinkingLevel: "medium",
            maxTurns: 0,
          },
        }),
      ),
    ).toThrow(/Invalid summary/);
  });

  it("normalizes absent-like optional string hints", () => {
    const parsed = parseAgentOnboardingResponse(
      JSON.stringify({
        type: "complete",
        data: {
          name: "Hermes Desktop Tester",
          role: "executor",
          instructionsText: "Exercise desktop workflows with Hermes computer-use tools.",
          thinkingLevel: "medium",
          maxTurns: 25,
          heartbeatProcedurePath: "  ",
          modelHint: "",
          runtimeHint: null,
        },
      }),
    );

    expect(parsed.type).toBe("complete");
    if (parsed.type === "complete") {
      expect(parsed.data.heartbeatProcedurePath).toBeUndefined();
      expect(parsed.data.modelHint).toBeUndefined();
      expect(parsed.data.runtimeHint).toBeUndefined();
    }
  });

  it("rejects malformed rich draft fields", () => {
    expect(() =>
      parseAgentOnboardingResponse(
        JSON.stringify({
          type: "complete",
          data: {
            name: "Malformed",
            role: "reviewer",
            instructionsText: "Valid instructions",
            thinkingLevel: "medium",
            maxTurns: 20,
            heartbeatProcedurePath: 42,
          },
        }),
      ),
    ).toThrow("Invalid summary.heartbeatProcedurePath");

    expect(() =>
      parseAgentOnboardingResponse(
        JSON.stringify({
          type: "complete",
          data: {
            name: "Malformed",
            role: "reviewer",
            instructionsText: "Valid instructions",
            thinkingLevel: "medium",
            maxTurns: 20,
            heartbeatIntervalMs: 0,
          },
        }),
      ),
    ).toThrow("Invalid summary.heartbeatIntervalMs");

    expect(() =>
      parseAgentOnboardingResponse(
        JSON.stringify({
          type: "complete",
          data: {
            name: "Malformed",
            role: "reviewer",
            instructionsText: "Valid instructions",
            thinkingLevel: "medium",
            maxTurns: 20,
            heartbeatEnabled: "yes",
            modelHint: 10,
            runtimeHint: { runtime: "openclaw" },
          },
        }),
      ),
    ).toThrow(/Invalid summary\.(heartbeatEnabled|modelHint|runtimeHint)/);
  });

  it("builds compact onboarding context prompt for create mode", () => {
    const prompt = createAgentOnboardingSessionPrompt({
      mode: "create",
      intent: "Need a reviewer for docs",
      existingAgents: [{ id: "a1", name: "Alpha", role: "reviewer" }],
      templates: [{ id: "t1", label: "Reviewer Template", description: "General reviewer" }],
    });

    expect(prompt).toContain("Need a reviewer for docs");
    expect(prompt).toContain("a1:Alpha(reviewer)");
    expect(prompt).toContain("t1:Reviewer Template");
    expect(prompt).not.toContain("Current agent configuration:");
  });

  it("appends current agent configuration in edit mode prompt", () => {
    const prompt = createAgentOnboardingSessionPrompt({
      mode: "edit",
      intent: "Improve this agent",
      existingAgents: [{ id: "a1", name: "Alpha", role: "reviewer" }],
      templates: [{ id: "t1", label: "Reviewer Template", description: "General reviewer" }],
      existingAgentConfig: {
        name: "Alpha",
        role: "reviewer",
        title: "Senior Reviewer",
        instructionsText: "Current instructions",
        soul: "Calm",
        memory: "Team context",
        reportsTo: "mgr-1",
        skills: ["linting"],
        model: "openai/gpt-5-mini",
        thinkingLevel: "low",
        maxTurns: 40,
        runtimeHint: "gpu",
        heartbeatIntervalMs: 30000,
        heartbeatTimeoutMs: 120000,
        maxConcurrentRuns: 2,
        messageResponseMode: "immediate",
      },
    });

    expect(prompt).toContain("Current agent configuration:");
    expect(prompt).toContain("name: Alpha");
    expect(prompt).toContain("instructionsText: Current instructions");
    expect(prompt).toContain("messageResponseMode: immediate");
  });

  it("asks the onboarding model for runtime hints that can select Hermes", async () => {
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "goal", type: "text", question: "What is the primary goal?" },
        }),
      ]),
    );

    await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "Use the Hermes runtime for computer-use testing", existingAgents: [], templates: [] },
      process.cwd(),
    );

    const options = mockCreateFnAgent.mock.calls.at(-1)?.[0] as { systemPrompt?: string };
    expect(options.systemPrompt).toContain('"runtimeHint"');
    expect(options.systemPrompt).toContain("optional draft suggestions");
    expect(options.systemPrompt).toContain('use the exact runtimeHint "hermes"');
    expect(options.systemPrompt).not.toContain("Do not include runtimeMode/model/runtimeHint");
  });

  it("requests role-fallback and enabled plugin skills for model-only onboarding agents", async () => {
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "goal", type: "text", question: "What is the primary goal?" },
        }),
      ]),
    );

    await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "skills", existingAgents: [], templates: [] },
      process.cwd(),
      undefined,
      undefined,
      undefined,
      createSkillPluginRunner([
        { name: "ce-debug" },
        { name: "disabled-skill", enabled: false },
      ]),
    );

    const options = mockCreateFnAgent.mock.calls.at(-1)?.[0] as { skillSelection?: { requestedSkillNames?: string[] } };
    expect(options.skillSelection?.requestedSkillNames).toEqual(["fusion", "ce-debug"]);
  });

  it("forwards store-resolved MCP servers to onboarding helper agents", async () => {
    const mcpServers = [{ name: "planning-helper", command: "mcp-helper", env: { TOKEN: "materialized-secret" } }];
    const store = { getSettingsByScope: vi.fn() };
    mockResolveMcpServersForStore.mockResolvedValueOnce({ servers: mcpServers, errors: [] });
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "goal", type: "text", question: "What is the primary goal?" },
        }),
      ]),
    );

    await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "mcp", existingAgents: [], templates: [] },
      process.cwd(),
      undefined,
      undefined,
      undefined,
      undefined,
      store as never,
    );

    expect(mockResolveMcpServersForStore).toHaveBeenCalledWith(store);
    const options = mockCreateFnAgent.mock.calls.at(-1)?.[0] as { mcpServers?: unknown[] };
    expect(options.mcpServers).toBe(mcpServers);
  });

  it("uses the retry scoped store when recreating an uninitialized onboarding helper agent", async () => {
    const startStore = { getSettingsByScope: vi.fn() };
    const retryStore = { getSettingsByScope: vi.fn() };
    const retryMcpServers = [{ name: "planning-helper", command: "mcp-helper", env: { TOKEN: "retry-secret" } }];
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "goal", type: "text", question: "What is the primary goal?" },
        }),
      ]),
    );

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "mcp retry", existingAgents: [], templates: [] },
      process.cwd(),
      undefined,
      undefined,
      undefined,
      undefined,
      startStore as never,
    );
    const session = getAgentOnboardingSession(sessionId) as { agent?: unknown; error?: string };
    session.agent = undefined;
    session.error = "AI generation timed out. You can retry.";
    mockResolveMcpServersForStore.mockClear();
    mockResolveMcpServersForStore.mockResolvedValueOnce({ servers: retryMcpServers, errors: [] });
    mockCreateFnAgent.mockResolvedValueOnce(createMockAgent([JSON.stringify({ type: "question", data: { id: "retry", type: "text", question: "Retry?" } })]));

    await retryAgentOnboardingSession(sessionId, retryStore as never);

    expect(mockResolveMcpServersForStore).toHaveBeenCalledWith(retryStore);
    const options = mockCreateFnAgent.mock.calls.at(-1)?.[0] as { mcpServers?: unknown[] };
    expect(options.mcpServers).toBe(retryMcpServers);
  });

  it("requests role-fallback skills when onboarding plugin runner is unavailable", async () => {
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "goal", type: "text", question: "What is the primary goal?" },
        }),
      ]),
    );

    await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "skills", existingAgents: [], templates: [] },
      process.cwd(),
    );

    const options = mockCreateFnAgent.mock.calls.at(-1)?.[0] as { skillSelection?: { requestedSkillNames?: string[] } };
    expect(options.skillSelection?.requestedSkillNames).toEqual(["fusion"]);
  });

  it("preserves valid JSON from thinking-only assistant responses", async () => {
    const response = JSON.stringify({
      type: "question",
      data: { id: "goal", type: "text", question: "What is the primary goal?" },
    });
    const messages: Array<{
      role: string;
      content: Array<{ type: "thinking"; thinking: string }>;
    }> = [];
    mockCreateFnAgent.mockImplementationOnce(async (options: unknown) => {
      const callbacks = options as { onThinking?: (delta: string) => void };
      return {
        session: {
          state: { messages },
          prompt: vi.fn(async () => {
            callbacks.onThinking?.(response);
            messages.push({ role: "assistant", content: [{ type: "thinking", thinking: response }] });
          }),
          dispose: vi.fn(),
        },
      };
    });

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "thinking-only response", existingAgents: [], templates: [] },
      process.cwd(),
    );

    await waitForOnboardingEvent(sessionId, ["question", "error"]);

    const session = getAgentOnboardingSession(sessionId);
    expect(session?.error).toBeUndefined();
    expect(session?.currentQuestion?.id).toBe("goal");
  });

  it("retries once when the model response is not valid JSON", async () => {
    const agent = createMockAgent([
      "I can help design that agent.",
      JSON.stringify({
        type: "question",
        data: { id: "goal", type: "text", question: "What is the primary goal?" },
      }),
    ]);
    mockCreateFnAgent.mockResolvedValueOnce(agent);

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "recover malformed output", existingAgents: [], templates: [] },
      process.cwd(),
    );

    await waitForOnboardingEvent(sessionId, ["question", "error"]);

    const session = getAgentOnboardingSession(sessionId);
    expect(session?.error).toBeUndefined();
    expect(session?.currentQuestion?.id).toBe("goal");
    expect(agent.session.prompt).toHaveBeenCalledTimes(2);
  });

  it("progresses through start -> question -> response -> final summary", async () => {
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "goal", type: "text", question: "What is the primary goal?" },
        }),
        JSON.stringify({
          type: "complete",
          data: {
            name: "Repo Steward",
            role: "engineer",
            instructionsText: "Keep the repo healthy and triage drift.",
            thinkingLevel: "low",
            maxTurns: 18,
            templateId: "eng-template",
            rationale: "Template path selected",
          },
        }),
      ]),
    );

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      {
        intent: "I need an engineer for repository hygiene",
        existingAgents: [{ id: "agent-1", name: "Alpha", role: "engineer" }],
        templates: [{ id: "eng-template", label: "Engineer template" }],
      },
      process.cwd(),
    );

    await waitFor(() => Boolean(getAgentOnboardingSession(sessionId)?.currentQuestion));
    const session = getAgentOnboardingSession(sessionId);
    expect(session?.currentQuestion?.id).toBe("goal");

    await respondToAgentOnboarding(sessionId, { goal: "Keep CI green" });
    await waitFor(() => Boolean(getAgentOnboardingSummary(sessionId)));

    const summary = getAgentOnboardingSummary(sessionId);
    expect(summary?.name).toBe("Repo Steward");
    expect(summary?.templateId).toBe("eng-template");
  });

  it("defaults onboarding sessions to create mode", async () => {
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "q1", type: "text", question: "What should this agent do?" },
        }),
      ]),
    );

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "create", existingAgents: [], templates: [] },
      process.cwd(),
    );

    await waitFor(() => Boolean(getAgentOnboardingSession(sessionId)));
    expect(getAgentOnboardingSession(sessionId)?.mode).toBe("create");
  });

  it("stores edit mode sessions and includes current config in agent prompt", async () => {
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "q1", type: "text", question: "What should change?" },
        }),
      ]),
    );

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      {
        mode: "edit",
        intent: "Improve this agent",
        existingAgents: [],
        templates: [],
        existingAgentConfig: {
          name: "Editor",
          instructionsText: "Current instructions",
          messageResponseMode: "on-heartbeat",
        },
      },
      process.cwd(),
    );

    await waitFor(() => Boolean(getAgentOnboardingSession(sessionId)?.currentQuestion));
    expect(getAgentOnboardingSession(sessionId)?.mode).toBe("edit");
    expect(getAgentOnboardingSession(sessionId)?.contextPrompt).toContain("Current agent configuration:");
    expect(getAgentOnboardingSession(sessionId)?.contextPrompt).toContain("name: Editor");
  });

  it("throws InvalidSessionStateError when responding without an active question", async () => {
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "complete",
          data: {
            name: "Direct Summary",
            role: "reviewer",
            instructionsText: "Review with no follow-up",
            thinkingLevel: "minimal",
            maxTurns: 12,
          },
        }),
      ]),
    );

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "quick", existingAgents: [], templates: [] },
      process.cwd(),
    );

    await waitFor(() => Boolean(getAgentOnboardingSummary(sessionId)));

    await expect(respondToAgentOnboarding(sessionId, { followup: "anything" })).rejects.toBeInstanceOf(
      InvalidSessionStateError,
    );
  });

  /*
  FNXC:PlanningRetry 2026-07-14-00:00:
  Same invariant as Planning Mode's answered-question fix: once an answer is accepted the
  session is no longer awaiting input. currentQuestion must clear immediately (so the SSE
  catch-up path cannot re-emit the answered question) and retry after a failed turn must ask
  the next question instead of re-asking the answered one.

  FNXC:AgentOnboarding 2026-07-14-18:20:
  Generation failure after an answer must still resolve a successful respond payload (the
  answered question) instead of throwing — the route used to 400 with "Session did not produce
  a question", which bounced the client out of SSE-driven retry.
  */
  it("clears the answered question during generation and retries with the next-question prompt", async () => {
    const promptCalls: string[] = [];
    const messages: Array<{ role: string; content: string }> = [];
    const answeredQuestion = { id: "goal", type: "text" as const, question: "What is the agent's goal?" };
    mockCreateFnAgent.mockResolvedValue({
      session: {
        state: { messages },
        prompt: vi.fn(async (message: string) => {
          promptCalls.push(message);
          if (promptCalls.length === 1) {
            messages.push({
              role: "assistant",
              content: JSON.stringify({
                type: "question",
                data: answeredQuestion,
              }),
            });
            return;
          }
          if (promptCalls.length === 2) {
            throw new Error("provider exploded");
          }
          messages.push({
            role: "assistant",
            content: JSON.stringify({
              type: "question",
              data: { id: "scope", type: "text", question: "What is in scope?" },
            }),
          });
        }),
        dispose: vi.fn(),
      },
    });

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "answered-question invariant", existingAgents: [], templates: [] },
      process.cwd(),
    );
    await waitFor(() => Boolean(getAgentOnboardingSession(sessionId)?.currentQuestion));

    const result = await respondToAgentOnboarding(sessionId, { goal: "Keep CI green" });

    // Successful respond contract even on generation failure (Planning Mode parity).
    expect(result).toEqual({ type: "question", data: answeredQuestion });

    const session = getAgentOnboardingSession(sessionId);
    expect(session?.error).toMatch(/provider exploded/);
    // Regression: the answered question used to linger here and get re-emitted/re-asked.
    expect(session?.currentQuestion).toBeUndefined();

    await retryAgentOnboardingSession(sessionId);
    expect(promptCalls[2]).toContain("ask the next best onboarding question");
    expect(promptCalls[2]).not.toContain("continue from the last question");
    expect(getAgentOnboardingSession(sessionId)?.currentQuestion?.id).toBe("scope");
  });

  it("cancels session and subsequent access fails", async () => {
    mockCreateFnAgent.mockResolvedValueOnce(
      createMockAgent([
        JSON.stringify({
          type: "question",
          data: { id: "q1", type: "text", question: "Question before cancel" },
        }),
      ]),
    );

    const sessionId = await startAgentOnboardingSession(
      "127.0.0.1",
      { intent: "cancel flow", existingAgents: [], templates: [] },
      process.cwd(),
    );

    await waitFor(() => Boolean(getAgentOnboardingSession(sessionId)?.currentQuestion));
    await cancelAgentOnboardingSession(sessionId);

    expect(getAgentOnboardingSession(sessionId)).toBeUndefined();
    await expect(respondToAgentOnboarding(sessionId, { q1: "x" })).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
