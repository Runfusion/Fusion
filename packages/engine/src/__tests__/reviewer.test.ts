import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
}));

import { reviewStep, REVIEWER_SYSTEM_PROMPT } from "../reviewer.js";
import { createFnAgent } from "../pi.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

function createMockSession(reviewText: string) {
  return {
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockImplementation((cb: any) => {
        // Simulate the reviewer producing text
        cb({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: reviewText },
        });
      }),
      dispose: vi.fn(),
    },
  } as any;
}

describe("reviewStep — model settings threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes defaultProvider and defaultModelId to createFnAgent when provided", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("anthropic");
    expect(opts.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("does not set model fields when ReviewOptions omits them", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nAll good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {},
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBeUndefined();
    expect(opts.defaultModelId).toBeUndefined();
  });

  it("extracts APPROVE verdict correctly", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
    );

    expect(result.verdict).toBe("APPROVE");
  });
});

describe("reviewStep — spec review type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts verdict correctly for spec reviews", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("## Spec Review: KB-050\n\n### Verdict: APPROVE\n### Summary\nSpec looks complete and well-structured."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050\n\n## Mission\nDo something",
    );

    expect(result.verdict).toBe("APPROVE");
    expect(result.summary).toContain("well-structured");
  });

  it("extracts REVISE verdict for spec reviews", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("## Spec Review: KB-050\n\n### Verdict: REVISE\n### Summary\nMissing test requirements."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
    );

    expect(result.verdict).toBe("REVISE");
  });

  it("extracts RETHINK verdict for spec reviews", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("## Spec Review: KB-050\n\n### Verdict: RETHINK\n### Summary\nFundamentally wrong approach."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
    );

    expect(result.verdict).toBe("RETHINK");
  });

  it("calls createFnAgent with readonly tools and correct system prompt", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood spec."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.tools).toBe("readonly");
    expect(opts.systemPrompt).toContain("Spec Review Format");
    expect(opts.systemPrompt).toContain("Mission clarity");
  });

  it("injects read-only memory instructions and tools when project memory is enabled", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood spec."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
      undefined,
      { rootDir: "/tmp/project", settings: { memoryBackendType: "qmd" } as any },
    );

    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.systemPrompt).toContain("## Project Memory");
    expect(opts.systemPrompt).toContain("Do not update memory during review");
    expect(opts.customTools?.map((tool: any) => tool.name)).toEqual(["fn_memory_search", "fn_memory_get"]);
  });

  it("omits reviewer memory tools and instructions when memory is disabled", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood spec."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
      undefined,
      { rootDir: "/tmp/project", settings: { memoryEnabled: false } as any },
    );

    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.systemPrompt).not.toContain("## Project Memory");
    expect(opts.customTools).toBeUndefined();
  });

  it("builds review request with spec-specific instructions", async () => {
    let capturedPrompt = "";
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          capturedPrompt = prompt;
        }),
        subscribe: vi.fn().mockImplementation((cb: any) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nOK" },
          });
        }),
        dispose: vi.fn(),
      },
    } as any);

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec",
      "# Task: KB-050\n\n## Mission\nDo something great",
    );

    expect(capturedPrompt).toContain("Evaluate this PROMPT.md specification");
    expect(capturedPrompt).toContain("spec quality criteria");
    expect(capturedPrompt).toContain("# Task: KB-050");
    // Spec reviews should NOT contain git diff instructions
    expect(capturedPrompt).not.toContain("git diff");
  });

  it("does not include git diff instructions for spec reviews", async () => {
    let capturedPrompt = "";
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          capturedPrompt = prompt;
        }),
        subscribe: vi.fn().mockImplementation((cb: any) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nOK" },
          });
        }),
        dispose: vi.fn(),
      },
    } as any);

    // Pass a baseline — should be ignored for spec reviews
    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec",
      "# Task: KB-050", "abc123",
    );

    expect(capturedPrompt).not.toContain("git diff");
    expect(capturedPrompt).not.toContain("abc123");
  });
});

describe("reviewStep — exhausted-retry error detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when session.prompt() resolves with exhausted-retry error on state.error", async () => {
    // session.prompt() resolves normally, but session.state.error is set
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      dispose: vi.fn(),
      state: { error: "rate_limit_error: Rate limit exceeded" },
    };
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession } as any);

    await expect(
      reviewStep("/tmp/worktree", "FN-100", 1, "Test Step", "code", "# prompt"),
    ).rejects.toThrow("rate_limit_error: Rate limit exceeded");
  });

  it("disposes session in finally block despite the error", async () => {
    const disposeFn = vi.fn();
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      dispose: disposeFn,
      state: { error: "rate_limit_error: Rate limit exceeded" },
    };
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession } as any);

    await expect(
      reviewStep("/tmp/worktree", "FN-100", 1, "Test Step", "code", "# prompt"),
    ).rejects.toThrow();

    // Session should be disposed in the finally block
    expect(disposeFn).toHaveBeenCalled();
  });

  it("does not throw when session completes without error", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
    );

    expect(result.verdict).toBe("APPROVE");
  });
});

describe("reviewStep — validator model overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses taskValidatorProvider and taskValidatorModelId when both are set", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        taskValidatorProvider: "anthropic",
        taskValidatorModelId: "claude-sonnet-4-5",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("anthropic");
    expect(opts.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("falls back to defaultProvider/defaultModelId when taskValidatorProvider is missing", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        // taskValidatorProvider is missing
        taskValidatorModelId: "claude-sonnet-4-5",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("falls back to defaultProvider/defaultModelId when taskValidatorModelId is missing", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        taskValidatorProvider: "anthropic",
        // taskValidatorModelId is missing
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("falls back to defaultProvider/defaultModelId when both validator fields are undefined", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("resolves project validator override when task override is not set", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        projectValidatorProvider: "anthropic",
        projectValidatorModelId: "claude-opus-4",
        // taskValidatorProvider is not set
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("anthropic");
    expect(opts.defaultModelId).toBe("claude-opus-4");
  });

  it("resolves global validator lane when project override is not set", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        globalValidatorProvider: "google",
        globalValidatorModelId: "gemini-2.5",
        // projectValidatorProvider is not set
        // taskValidatorProvider is not set
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("google");
    expect(opts.defaultModelId).toBe("gemini-2.5");
  });

  it("uses project default override when validator lanes are absent", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        projectDefaultOverrideProvider: "openai",
        projectDefaultOverrideModelId: "gpt-4o",
        // No validator lanes set
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("falls through to execution default when project default override is incomplete", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        projectDefaultOverrideProvider: "openai",
        // projectDefaultOverrideModelId intentionally omitted
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("anthropic");
    expect(opts.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("falls back to execution default when no validator lanes are set", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        // No validator lanes set
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });
});

describe("REVIEWER_SYSTEM_PROMPT", () => {
  it("includes subtask breakdown criterion in spec review", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Subtask breakdown");
    expect(REVIEWER_SYSTEM_PROMPT).toContain(
      "8+ implementation steps",
    );
  });

  it("includes undersplit task detection guidance", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("8 or more implementation steps");
    expect(REVIEWER_SYSTEM_PROMPT).toContain(
      "3+ different packages but wasn't split",
    );
  });

  it("instructs planner to use fn_task_create for undersplit tasks", () => {
    // The reviewer's REVISE feedback must explicitly direct the planner to
    // create child tasks via fn_task_create rather than just flagging the issue.
    expect(REVIEWER_SYSTEM_PROMPT).toContain("fn_task_create");
    expect(REVIEWER_SYSTEM_PROMPT).toContain(
      "create 2–5 child tasks",
    );
    expect(REVIEWER_SYSTEM_PROMPT).toContain(
      "Do NOT write a parent PROMPT.md",
    );
  });

  it("includes user comment coverage criterion in spec review format", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("User comment coverage");
    expect(REVIEWER_SYSTEM_PROMPT).toContain("missing coverage is a blocking REVISE");
  });

  it("includes worktree boundary guidance for code reviews", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Worktree Boundary Review");
    expect(REVIEWER_SYSTEM_PROMPT).toContain("assigned task worktree");
    expect(REVIEWER_SYSTEM_PROMPT).toContain("blocking REVISE");
    expect(REVIEWER_SYSTEM_PROMPT).toContain(".fusion/memory/");
  });
});

describe("reviewStep — user comments in spec review", () => {
  let mockedCreateFnAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedCreateFnAgent = vi.fn().mockResolvedValue({
      session: {
        prompt: vi.fn(),
        subscribe: vi.fn().mockImplementation((cb: any) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nOK" },
          });
        }),
        dispose: vi.fn(),
        sessionManager: { getLeafId: vi.fn() },
      },
    } as any);
    vi.mocked(createFnAgent).mockImplementation(mockedCreateFnAgent);
  });

  it("includes user comments in spec review request", async () => {
    let capturedPrompt = "";
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          capturedPrompt = prompt;
        }),
        subscribe: vi.fn().mockImplementation((cb: any) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nOK" },
          });
        }),
        dispose: vi.fn(),
      },
    } as any);

    const userComments = [
      {
        id: "c1",
        text: "Make sure to handle the edge case",
        author: "user",
        createdAt: "2026-01-02T10:00:00.000Z",
      },
    ];

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Specification", "spec",
      "# Task: FN-050\n\n## Mission\nDo something",
      undefined,
      { userComments },
    );

    expect(capturedPrompt).toContain("User Comment Coverage (MANDATORY)");
    expect(capturedPrompt).toContain("Make sure to handle the edge case");
    expect(capturedPrompt).toContain("issue a REVISE verdict");
  });

  it("does not include user comments section when no comments provided", async () => {
    let capturedPrompt = "";
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          capturedPrompt = prompt;
        }),
        subscribe: vi.fn().mockImplementation((cb: any) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nOK" },
          });
        }),
        dispose: vi.fn(),
      },
    } as any);

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Specification", "spec",
      "# Task: FN-050\n\n## Mission\nDo something",
    );

    expect(capturedPrompt).not.toContain("User Comment Coverage");
  });

  it("does not include user comments for non-spec review types", async () => {
    let capturedPrompt = "";
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          capturedPrompt = prompt;
        }),
        subscribe: vi.fn().mockImplementation((cb: any) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nOK" },
          });
        }),
        dispose: vi.fn(),
      },
    } as any);

    const userComments = [
      {
        id: "c1",
        text: "Some user feedback",
        author: "user",
        createdAt: "2026-01-02T10:00:00.000Z",
      },
    ];

    await reviewStep(
      "/tmp/worktree", "FN-050", 1, "Implementation", "code",
      "# Task: FN-050\n\n## Mission\nDo something",
      "abc123",
      { userComments },
    );

    // Code reviews should not have user comment coverage checks
    expect(capturedPrompt).not.toContain("User Comment Coverage");
  });

  it("includes assigned worktree boundary instructions for code reviews", async () => {
    let capturedPrompt = "";
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          capturedPrompt = prompt;
        }),
        subscribe: vi.fn().mockImplementation((cb: any) => {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nOK" },
          });
        }),
        dispose: vi.fn(),
      },
    } as any);

    await reviewStep(
      "/tmp/project/.worktrees/happy-robin", "FN-050", 1, "Implementation", "code",
      "# Task: FN-050\n\n## Mission\nDo something",
      "abc123",
    );

    expect(capturedPrompt).toContain("## Worktree Boundary");
    expect(capturedPrompt).toContain("Assigned task worktree: `/tmp/project/.worktrees/happy-robin`");
    expect(capturedPrompt).toContain("primary project checkout");
    expect(capturedPrompt).toContain(".fusion/memory/");
  });
});

describe("reviewStep — skill selection resolver contract (FN-1510/FN-1511)", () => {
  // Mock session-skill-context to control skill selection behavior
  vi.mock("../session-skill-context.js", () => ({
    buildSessionSkillContext: vi.fn(),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes skillSelection to createFnAgent when agentStore and rootDir are provided", async () => {
    const { buildSessionSkillContext } = await import("../session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({
      skillSelectionContext: {
        projectRootDir: "/tmp/project",
        requestedSkillNames: ["fusion"],
        sessionPurpose: "reviewer",
      },
      resolvedSkillNames: ["fusion"],
      skillSource: "role-fallback",
    });

    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood."),
    );

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        agentStore: mockAgentStore as any,
        rootDir: "/tmp/project",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.skillSelection).toBeDefined();
    expect(opts.skillSelection!.projectRootDir).toBe("/tmp/project");
    expect(opts.skillSelection!.requestedSkillNames).toEqual(["fusion"]);
    expect(opts.skillSelection!.sessionPurpose).toBe("reviewer");
  });

  it("uses assigned agent skills when available", async () => {
    const { buildSessionSkillContext } = await import("../session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({
      skillSelectionContext: {
        projectRootDir: "/tmp/project",
        requestedSkillNames: ["custom-skill", "another-skill"],
        sessionPurpose: "reviewer",
      },
      resolvedSkillNames: ["custom-skill", "another-skill"],
      skillSource: "assigned-agent",
    });

    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood."),
    );

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        task: { assignedAgentId: "agent-001" },
        agentStore: mockAgentStore as any,
        rootDir: "/tmp/project",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.skillSelection).toBeDefined();
    expect(opts.skillSelection!.requestedSkillNames).toEqual(["custom-skill", "another-skill"]);
    expect(opts.skillSelection!.sessionPurpose).toBe("reviewer");
  });

  it("does not pass skillSelection when buildSessionSkillContext returns undefined context", async () => {
    const { buildSessionSkillContext } = await import("../session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({
      skillSelectionContext: undefined,
      resolvedSkillNames: [],
      skillSource: "none",
    });

    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood."),
    );

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        agentStore: mockAgentStore as any,
        rootDir: "/tmp/project",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    // skillSelection should not be present when context is undefined
    expect("skillSelection" in opts).toBe(false);
  });

  it("does not pass skillSelection when agentStore or rootDir is missing", async () => {
    // Without agentStore/rootDir, buildSessionSkillContext is never called
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        // No agentStore or rootDir
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect("skillSelection" in opts).toBe(false);
  });

  it("gracefully handles buildSessionSkillContext throwing", async () => {
    const { buildSessionSkillContext } = await import("../session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockRejectedValue(new Error("Agent not found"));

    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood."),
    );

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    // Should not throw - graceful fallback
    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        agentStore: mockAgentStore as any,
        rootDir: "/tmp/project",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect("skillSelection" in opts).toBe(false);
  });

  it("records resolved skill names in skill context result", async () => {
    const { buildSessionSkillContext } = await import("../session-skill-context.js");
    const resolvedNames = ["skill-a", "skill-b", "skill-c"];
    vi.mocked(buildSessionSkillContext).mockResolvedValue({
      skillSelectionContext: {
        projectRootDir: "/tmp/project",
        requestedSkillNames: resolvedNames,
        sessionPurpose: "reviewer",
      },
      resolvedSkillNames: resolvedNames,
      skillSource: "assigned-agent",
    });

    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood."),
    );

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        agentStore: mockAgentStore as any,
        rootDir: "/tmp/project",
      },
    );

    // Verify the resolved names are passed to createFnAgent
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.skillSelection?.requestedSkillNames).toEqual(resolvedNames);
  });

  it("uses sessionPurpose='reviewer' in skill selection context", async () => {
    const { buildSessionSkillContext } = await import("../session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({
      skillSelectionContext: {
        projectRootDir: "/tmp/project",
        requestedSkillNames: ["fusion"],
        sessionPurpose: "reviewer",
      },
      resolvedSkillNames: ["fusion"],
      skillSource: "role-fallback",
    });

    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood."),
    );

    const mockAgentStore = {
      listAgents: vi.fn().mockResolvedValue([]),
    };

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        agentStore: mockAgentStore as any,
        rootDir: "/tmp/project",
      },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.skillSelection?.sessionPurpose).toBe("reviewer");
  });
});
