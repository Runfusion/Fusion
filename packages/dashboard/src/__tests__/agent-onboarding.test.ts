import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreateFnAgent } = vi.hoisted(() => ({
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("@fusion/engine", () => ({
  createFnAgent: mockCreateFnAgent,
}));

import {
  __resetAgentOnboardingState,
  cancelAgentOnboardingSession,
  createAgentOnboardingSessionPrompt,
  getAgentOnboardingSession,
  getAgentOnboardingSummary,
  InvalidSessionStateError,
  parseAgentOnboardingResponse,
  respondToAgentOnboarding,
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

describe("agent-onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("parses complete summary responses", () => {
    const parsed = parseAgentOnboardingResponse(
      JSON.stringify({
        type: "complete",
        data: {
          name: "Docs Reviewer",
          role: "reviewer",
          instructionsText: "Review docs for clarity and accuracy.",
          thinkingLevel: "medium",
          maxTurns: 20,
        },
      }),
    );

    expect(parsed.type).toBe("complete");
    if (parsed.type === "complete") {
      expect(parsed.data.name).toBe("Docs Reviewer");
      expect(parsed.data.maxTurns).toBe(20);
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

  it("builds compact onboarding context prompt", () => {
    const prompt = createAgentOnboardingSessionPrompt({
      intent: "Need a reviewer for docs",
      existingAgents: [{ id: "a1", name: "Alpha", role: "reviewer" }],
      templates: [{ id: "t1", label: "Reviewer Template", description: "General reviewer" }],
    });

    expect(prompt).toContain("Need a reviewer for docs");
    expect(prompt).toContain("a1:Alpha(reviewer)");
    expect(prompt).toContain("t1:Reviewer Template");
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
