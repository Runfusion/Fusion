import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
}));

import { reviewStep } from "./reviewer.js";
import { createKbAgent } from "./pi.js";

const mockedCreateHaiAgent = vi.mocked(createKbAgent);

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

  it("passes defaultProvider and defaultModelId to createKbAgent when provided", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
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

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("anthropic");
    expect(opts.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("does not set model fields when ReviewOptions omits them", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nAll good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {},
    );

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBeUndefined();
    expect(opts.defaultModelId).toBeUndefined();
  });

  it("extracts APPROVE verdict correctly", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
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
    mockedCreateHaiAgent.mockResolvedValue(
      createMockSession("## Spec Review: KB-050\n\n### Verdict: APPROVE\n### Summary\nSpec looks complete and well-structured."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050\n\n## Mission\nDo something",
    );

    expect(result.verdict).toBe("APPROVE");
    expect(result.summary).toContain("well-structured");
  });

  it("extracts REVISE verdict for spec reviews", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
      createMockSession("## Spec Review: KB-050\n\n### Verdict: REVISE\n### Summary\nMissing test requirements."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
    );

    expect(result.verdict).toBe("REVISE");
  });

  it("extracts RETHINK verdict for spec reviews", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
      createMockSession("## Spec Review: KB-050\n\n### Verdict: RETHINK\n### Summary\nFundamentally wrong approach."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
    );

    expect(result.verdict).toBe("RETHINK");
  });

  it("calls createKbAgent with readonly tools and correct system prompt", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nGood spec."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Spec Review", "spec", "# Task: KB-050",
    );

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0];
    expect(opts.tools).toBe("readonly");
    expect(opts.systemPrompt).toContain("Spec Review Format");
    expect(opts.systemPrompt).toContain("Mission clarity");
  });

  it("builds review request with spec-specific instructions", async () => {
    let capturedPrompt = "";
    mockedCreateHaiAgent.mockResolvedValue({
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
    mockedCreateHaiAgent.mockResolvedValue({
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
    mockedCreateHaiAgent.mockResolvedValue({ session: mockSession } as any);

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
    mockedCreateHaiAgent.mockResolvedValue({ session: mockSession } as any);

    await expect(
      reviewStep("/tmp/worktree", "FN-100", 1, "Test Step", "code", "# prompt"),
    ).rejects.toThrow();

    // Session should be disposed in the finally block
    expect(disposeFn).toHaveBeenCalled();
  });

  it("does not throw when session completes without error", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
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

  it("uses validatorModelProvider and validatorModelId when both are set", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        validatorModelProvider: "anthropic",
        validatorModelId: "claude-sonnet-4-5",
      },
    );

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("anthropic");
    expect(opts.defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("falls back to defaultProvider/defaultModelId when validatorModelProvider is missing", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        // validatorModelProvider is missing
        validatorModelId: "claude-sonnet-4-5",
      },
    );

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("falls back to defaultProvider/defaultModelId when validatorModelId is missing", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        defaultProvider: "openai",
        defaultModelId: "gpt-4o",
        validatorModelProvider: "anthropic",
        // validatorModelId is missing
      },
    );

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });

  it("falls back to defaultProvider/defaultModelId when both validator fields are undefined", async () => {
    mockedCreateHaiAgent.mockResolvedValue(
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

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateHaiAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("openai");
    expect(opts.defaultModelId).toBe("gpt-4o");
  });
});
