import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  formatModelMarkerDetails: vi.fn((model: string) => model),
  promptWithFallback: vi.fn(async (session: any, prompt: string, options?: any) => {
    if (options == null) await session.prompt(prompt);
    else await session.prompt(prompt, options);
  }),
}));

vi.mock("../agents/agent-session-helpers.js", () => ({
  createResolvedAgentSession: vi.fn(),
  extractRuntimeHint: vi.fn().mockReturnValue(undefined),
  resolveValidatorSessionModel: vi.fn().mockReturnValue({
    provider: "mock-provider",
    modelId: "mock-model",
  }),
}));

import { reviewStep } from "../execution/reviewer.js";
import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";

const mockedCreateResolvedAgentSession = vi.mocked(createResolvedAgentSession);

function buildSession(reviewText: string) {
  const prompt = vi.fn().mockResolvedValue(undefined);
  return {
    session: {
      prompt,
      subscribe: vi.fn().mockImplementation((cb: any) => {
        cb({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: reviewText },
        });
      }),
      dispose: vi.fn(),
    },
  } as any;
}

describe("FN-4068 baseline — plan review UNAVAILABLE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries once then returns terminal UNAVAILABLE when verdict is not parseable", async () => {
    mockedCreateResolvedAgentSession
      .mockResolvedValueOnce(buildSession("Reviewer output without verdict heading."))
      .mockResolvedValueOnce(buildSession("Still no verdict heading."));

    const store = {
      getSettings: vi.fn().mockResolvedValue({}),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await reviewStep(
      "/tmp/worktree",
      "FN-4092",
      2,
      "Reproduce stall",
      "plan",
      "# prompt",
      undefined,
      { store, taskId: "FN-4092" },
    );

    expect(result.verdict).toBe("UNAVAILABLE");
    expect(result.review).toContain("Still no verdict heading");
    expect(mockedCreateResolvedAgentSession).toHaveBeenCalledTimes(2);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4092",
      expect.stringContaining("review retry with fallback model after UNAVAILABLE verdict"),
    );
  });

  it("retries on the same model with stricter verdict instruction when fallback model is not configured", async () => {
    const first = buildSession("No parseable verdict here.");
    const second = buildSession("### Verdict: APPROVE\n### Summary\nRecovered.");
    mockedCreateResolvedAgentSession
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const result = await reviewStep(
      "/tmp/worktree",
      "FN-4092",
      2,
      "Reproduce stall",
      "plan",
      "# prompt",
      undefined,
      {},
    );

    expect(result.verdict).toBe("APPROVE");
    expect(mockedCreateResolvedAgentSession).toHaveBeenCalledTimes(2);
    expect(second.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining('Respond with exactly one of: APPROVE | REVISE | RETHINK on a line starting with "Verdict:"'),
    );
  });
});
