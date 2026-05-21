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
import { createFnAgent, promptWithFallback } from "../pi.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedPromptWithFallback = vi.mocked(promptWithFallback);
const CONTEXT_LIMIT_ERROR = "exceeded model token limit: 262144 (requested: 262879)";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockedPromptWithFallback.mockImplementation(async (session, prompt, options) => {
    if (options == null) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  });
});

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

  it("appends reviewer plugin prompt contributions when provided", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood spec."),
    );

    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn().mockReturnValue([
        { pluginId: "plugin-review", contribution: { content: "Follow plugin reviewer rubric." } },
      ]),
    };

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
      undefined,
      { pluginRunner: pluginRunner as any },
    );

    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.systemPrompt).toContain("## Plugin: plugin-review");
    expect(opts.systemPrompt).toContain("Follow plugin reviewer rubric.");
  });

  it("keeps reviewer system prompt unchanged when no reviewer plugin contributions exist", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood spec."),
    );

    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn().mockReturnValue([]),
    };

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
      undefined,
      { pluginRunner: pluginRunner as any },
    );

    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.systemPrompt).not.toContain("## Plugin:");
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
    expect(opts.customTools?.map((tool: any) => tool.name)).toEqual(["fn_web_fetch", "fn_memory_search", "fn_memory_get"]);
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
    expect(opts.customTools?.map((tool: any) => tool.name)).toEqual(["fn_web_fetch"]);
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
    expect(capturedPrompt).toContain("dangling task-document references");
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

describe("reviewStep — context-limit retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries with a compacted request when the first prompt hits a context limit", async () => {
    const subscribers: Array<(event: any) => void> = [];
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          for (const subscriber of subscribers) {
            subscriber({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "### Verdict: APPROVE\n### Summary\nCompacted retry worked." },
            });
          }
        }),
        subscribe: vi.fn().mockImplementation((cb: any) => {
          subscribers.push(cb);
        }),
        dispose: vi.fn(),
      },
    } as any);

    const task = { id: "FN-4082", column: "in-progress", description: "d", dependencies: [], steps: [], currentStep: 0, log: [], prompt: "# prompt", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reviewerContextRetryCount: 0 };
    const store = {
      getSettings: vi.fn().mockResolvedValue({ maxReviewerContextRetries: 2, maxTotalRetriesBeforeFail: 25 }),
      getTask: vi.fn().mockImplementation(async () => task),
      updateTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    mockedPromptWithFallback
      .mockImplementationOnce(async () => {
        throw new Error(CONTEXT_LIMIT_ERROR);
      })
      .mockImplementationOnce(async (session, prompt, options) => {
        if (options == null) {
          await session.prompt(prompt);
        } else {
          await session.prompt(prompt, options);
        }
      });

    const verboseSection = Array.from({ length: 120 }, (_, i) => `- verbose requirement ${i}: ${"x".repeat(80)}`).join("\n");
    const promptContent = `# Task: FN-4082\n\n## Mission\nShip the reviewer retry.\n\n## Context to Read First\n${verboseSection}\n\n## Dependencies\n- None\n\n## File Scope\n- packages/engine/src/reviewer.ts\n- packages/engine/src/pi.ts\n\n## Steps\n### Step 0: Preflight\n- [ ] Confirm existing behavior\n### Step 1: Compact prompt\n- [ ] Trim the request\n### Step 2: Retry review\n- [ ] Retry once\n\n## Do NOT\n${verboseSection}`;

    const result = await reviewStep(
      "/tmp/worktree",
      "FN-4082",
      2,
      "Retry review",
      "code",
      promptContent,
      "abc123",
      { store: store as any, taskId: "FN-4082" },
    );

    expect(result.verdict).toBe("APPROVE");
    expect(mockedPromptWithFallback).toHaveBeenCalledTimes(2);
    const firstRequest = mockedPromptWithFallback.mock.calls[0]?.[1] as string;
    const secondRequest = mockedPromptWithFallback.mock.calls[1]?.[1] as string;
    expect(secondRequest.length).toBeLessThan(firstRequest.length);
    expect(secondRequest).toContain("## Task PROMPT.md");
    expect(secondRequest).toContain("## Mission");
    expect(secondRequest).toContain("## File Scope");
    expect(secondRequest).toContain("### Step 1: Compact prompt");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4082",
      "code review hit context limit — retrying with compacted request",
    );
    expect(task.reviewerContextRetryCount).toBe(1);
  });

  it("returns UNAVAILABLE when both attempts hit the context limit", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nCompacted retry worked."),
    );

    mockedPromptWithFallback.mockImplementation(async () => {
      throw new Error(CONTEXT_LIMIT_ERROR);
    });

    const runReview = async () => {
      try {
        return await reviewStep(
          "/tmp/worktree",
          "FN-4082",
          2,
          "Retry review",
          "code",
          "# Task: FN-4082\n\n## Mission\nShip the reviewer retry.",
          "abc123",
        );
      } catch {
        return { verdict: "UNAVAILABLE" as const };
      }
    };

    await expect(runReview()).resolves.toEqual({ verdict: "UNAVAILABLE" });
    expect(mockedPromptWithFallback).toHaveBeenCalledTimes(4);
  });
});

describe("reviewStep — fallback retry for terminal unavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries once on fallback model when first verdict is UNAVAILABLE", async () => {
    mockedCreateFnAgent
      .mockResolvedValueOnce(createMockSession("No parseable verdict here."))
      .mockResolvedValueOnce(createMockSession("### Verdict: APPROVE\n### Summary\nRecovered on fallback."));

    const task = { id: "FN-4092", column: "in-progress", description: "d", dependencies: [], steps: [], currentStep: 0, log: [], prompt: "# prompt", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reviewerFallbackRetryCount: 0 };
    const store = {
      getSettings: vi.fn().mockResolvedValue({ maxReviewerFallbackRetries: 2, maxTotalRetriesBeforeFail: 25 }),
      getTask: vi.fn().mockImplementation(async () => task),
      updateTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reviewStep(
      "/tmp/worktree", "FN-4092", 2, "Retry", "plan", "# prompt", undefined,
      {
        store: store as any,
        taskId: "FN-4092",
        projectValidatorFallbackProvider: "openai",
        projectValidatorFallbackModelId: "gpt-5-mini",
      },
    );

    expect(result.verdict).toBe("APPROVE");
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4092",
      expect.stringContaining("review retry with fallback model after UNAVAILABLE verdict"),
    );
    expect(task.reviewerFallbackRetryCount).toBe(0);
  });

  it("resets reviewerFallbackRetryCount to 0 after a successful review following prior fallbacks", async () => {
    mockedCreateFnAgent
      .mockResolvedValueOnce(createMockSession("No parseable verdict here."))
      .mockResolvedValueOnce(createMockSession("### Verdict: APPROVE\n### Summary\nrecovered"));

    const task = { id: "FN-4093", column: "in-progress", description: "d", dependencies: [], steps: [], currentStep: 0, log: [], prompt: "# prompt", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reviewerFallbackRetryCount: 3 };
    const store = {
      getSettings: vi.fn().mockResolvedValue({ maxReviewerFallbackRetries: 8, maxTotalRetriesBeforeFail: 25 }),
      getTask: vi.fn().mockImplementation(async () => task),
      updateTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reviewStep(
      "/tmp/worktree", "FN-4093", 2, "Retry", "plan", "# prompt", undefined,
      {
        store: store as any,
        taskId: "FN-4093",
        projectValidatorFallbackProvider: "openai",
        projectValidatorFallbackModelId: "gpt-5-mini",
      },
    );

    expect(result.verdict).toBe("APPROVE");
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4093", { reviewerFallbackRetryCount: 0 });
    expect(task.reviewerFallbackRetryCount).toBe(0);
  });

  it("does not reset reviewerFallbackRetryCount when fallback remains UNAVAILABLE", async () => {
    mockedCreateFnAgent
      .mockResolvedValueOnce(createMockSession("No parseable verdict #1"))
      .mockResolvedValueOnce(createMockSession("No parseable verdict #2"));

    const task = { id: "FN-4094", column: "in-progress", description: "d", dependencies: [], steps: [], currentStep: 0, log: [], prompt: "# prompt", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reviewerFallbackRetryCount: 2 };
    const store = {
      getSettings: vi.fn().mockResolvedValue({ maxReviewerFallbackRetries: 8, maxTotalRetriesBeforeFail: 25 }),
      getTask: vi.fn().mockImplementation(async () => task),
      updateTask: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => Object.assign(task, patch)),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reviewStep(
      "/tmp/worktree", "FN-4094", 2, "Retry", "plan", "# prompt", undefined,
      {
        store: store as any,
        taskId: "FN-4094",
        projectValidatorFallbackProvider: "openai",
        projectValidatorFallbackModelId: "gpt-5-mini",
      },
    );

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reviewerFallbackRetryCount: 0 }),
    );
  });

  it("retries once after non-context reviewer error", async () => {
    mockedCreateFnAgent
      .mockResolvedValueOnce(createMockSession("### Verdict: APPROVE\n### Summary\nunused"))
      .mockResolvedValueOnce(createMockSession("### Verdict: REVISE\n### Summary\nRetry recovered."));

    mockedPromptWithFallback
      .mockRejectedValueOnce(new Error("transient reviewer failure"))
      .mockImplementation(async (session, prompt, options) => {
        if (options == null) await session.prompt(prompt);
        else await session.prompt(prompt, options);
      });

    const result = await reviewStep(
      "/tmp/worktree", "FN-4092", 2, "Retry", "code", "# prompt", "abc123",
      {
        projectValidatorFallbackProvider: "openai",
        projectValidatorFallbackModelId: "gpt-5-mini",
      },
    );

    expect(result.verdict).toBe("REVISE");
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
  });

  it("returns terminal UNAVAILABLE when fallback attempt is also UNAVAILABLE", async () => {
    mockedCreateFnAgent
      .mockResolvedValueOnce(createMockSession("No parseable verdict #1"))
      .mockResolvedValueOnce(createMockSession("No parseable verdict #2"));

    const result = await reviewStep(
      "/tmp/worktree", "FN-4092", 2, "Retry", "spec", "# prompt", undefined,
      {
        projectValidatorFallbackProvider: "openai",
        projectValidatorFallbackModelId: "gpt-5-mini",
      },
    );

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
  });

  it("does not retry pause-driven UNAVAILABLE", async () => {
    mockedCreateFnAgent.mockResolvedValue(createMockSession("### Verdict: APPROVE\n### Summary\nunused"));
    const store = {
      getSettings: vi.fn().mockResolvedValue({ globalPause: true }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reviewStep(
      "/tmp/worktree", "FN-4092", 2, "Retry", "plan", "# prompt", undefined,
      { store: store as any, taskId: "FN-4092" },
    );

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
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
      "12+ implementation steps",
    );
  });

  it("biases the reviewer toward keeping tasks whole", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("The bar for splitting is high");
    expect(REVIEWER_SYSTEM_PROMPT).toContain(
      "Default position:** do NOT flag undersplit",
    );
    expect(REVIEWER_SYSTEM_PROMPT).toContain("12+ implementation steps");
  });

  it("downgrades borderline undersplit findings to non-blocking suggestions", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain(
      "Suggestions** section instead of REVISE",
    );
  });

  it("instructs planner to use fn_task_create for genuinely oversized tasks", () => {
    // The reviewer's REVISE feedback must explicitly direct the planner to
    // create child tasks via fn_task_create rather than just flagging the issue.
    expect(REVIEWER_SYSTEM_PROMPT).toContain("fn_task_create");
    expect(REVIEWER_SYSTEM_PROMPT).toContain(
      "create 2–5 child tasks",
    );
    expect(REVIEWER_SYSTEM_PROMPT).toContain(
      "Not write a parent PROMPT.md",
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

describe("reviewStep — subagent lifecycle hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires onSessionCreated then onSessionEnded with the same session, in order", async () => {
    const mockSession = createMockSession("### Verdict: APPROVE\n### Summary\nOk.");
    mockedCreateFnAgent.mockResolvedValue(mockSession);

    const events: Array<{ type: "created" | "ended"; sameSession: boolean }> = [];
    const onSessionCreated = vi.fn((s: any) => {
      events.push({ type: "created", sameSession: s === mockSession.session });
    });
    const onSessionEnded = vi.fn((s: any) => {
      events.push({ type: "ended", sameSession: s === mockSession.session });
    });

    await reviewStep(
      "/tmp/worktree", "FN-200", 1, "Hook test", "plan", "# prompt",
      undefined,
      { onSessionCreated, onSessionEnded },
    );

    expect(onSessionCreated).toHaveBeenCalledTimes(1);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "created", sameSession: true },
      { type: "ended", sameSession: true },
    ]);
    expect(mockSession.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("fires onSessionEnded even when promptWithFallback throws", async () => {
    const mockSession = createMockSession("");
    mockedCreateFnAgent.mockResolvedValue(mockSession);
    const { promptWithFallback } = await import("../pi.js");
    vi.mocked(promptWithFallback).mockRejectedValue(new Error("boom"));

    const onSessionCreated = vi.fn();
    const onSessionEnded = vi.fn();

    await expect(
      reviewStep(
        "/tmp/worktree", "FN-201", 1, "Error path", "plan", "# prompt",
        undefined,
        { onSessionCreated, onSessionEnded },
      ),
    ).rejects.toThrow("boom");

    expect(onSessionCreated).toHaveBeenCalledTimes(2);
    expect(onSessionEnded).toHaveBeenCalledTimes(2);
  });
});
