import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  formatModelMarkerDetails: vi.fn((model: string, thinking?: string | null, annotations: string[] = []) => {
    const suffixes = [thinking ? `thinking effort: ${thinking}` : "", ...annotations].filter(Boolean);
    return suffixes.length ? `${model} ${suffixes.map((suffix) => `(${suffix})`).join(" ")}` : model;
  }),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (typeof session.prompt === "function") {
      if (options === undefined) {
        await session.prompt(prompt);
      } else {
        await session.prompt(prompt, options);
      }
    } else if (typeof session.promptWithFallback === "function") {
      await session.promptWithFallback(prompt, options);
    }
  }),
  // FNXC: pi.js tool-policy wrappers (wrapToolsWithRtkRewrite, wrapToolsWithPermanentAgentGating, wrapToolsWithActionGate) are now imported by agent-session-helpers.ts (wrapCustomToolsForPluginRuntime, called from createResolvedAgentSession). Mocks pass tools through unchanged.
  wrapToolsWithRtkRewrite: vi.fn((tools) => tools),
  wrapToolsWithPermanentAgentGating: vi.fn((tools) => tools),
  wrapToolsWithActionGate: vi.fn((tools) => tools),
}));

import { resolveAgentPrompt } from "@fusion/core";
import { reviewStep, ReviewerProviderError } from "../execution/reviewer.js";
import { createFnAgent, promptWithFallback } from "../pi.js";

const DEFAULT_REVIEWER_PROMPT = resolveAgentPrompt("reviewer");

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
  mockedPromptWithFallback.mockImplementation(async (session: any, prompt: any, options: any) => {
    if (typeof session.prompt === "function") {
      if (options == null) {
        await session.prompt(prompt);
      } else {
        await session.prompt(prompt, options);
      }
    } else if (typeof session.promptWithFallback === "function") {
      await session.promptWithFallback(prompt, options);
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

  it("uses task reviewer overrides before conflicting validator and default settings", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nReviewer override honored."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "code", "# prompt",
      "abc123",
      {
        taskValidatorProvider: "task-reviewer-provider",
        taskValidatorModelId: "task-reviewer-model",
        projectValidatorProvider: "project-reviewer-provider",
        projectValidatorModelId: "project-reviewer-model",
        globalValidatorProvider: "global-reviewer-provider",
        globalValidatorModelId: "global-reviewer-model",
        projectDefaultOverrideProvider: "project-default-provider",
        projectDefaultOverrideModelId: "project-default-model",
        defaultProvider: "global-default-provider",
        defaultModelId: "global-default-model",
      },
    );

    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("task-reviewer-provider");
    expect(opts.defaultModelId).toBe("task-reviewer-model");
  });

  it("falls through reviewer settings without mixing partial pairs", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nReviewer fallback honored."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        taskValidatorProvider: "task-provider-only",
        projectValidatorProvider: "project-provider-only",
        globalValidatorModelId: "global-model-only",
        projectDefaultOverrideProvider: "project-default-provider",
        projectDefaultOverrideModelId: "project-default-model",
        defaultProvider: "global-default-provider",
        defaultModelId: "global-default-model",
      },
    );

    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("project-default-provider");
    expect(opts.defaultModelId).toBe("project-default-model");
  });

  it("forces reviewer sessions to mock/scripted in test mode", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nTest mode honored."),
    );

    const result = await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        taskValidatorProvider: "task-reviewer-provider",
        taskValidatorModelId: "task-reviewer-model",
        projectValidatorProvider: "project-reviewer-provider",
        projectValidatorModelId: "project-reviewer-model",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        settings: { testMode: true } as any,
      },
    );

    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(result.verdict).toBe("APPROVE");
  });

  it("uses live store settings for reviewer test-mode forcing when settings snapshot is omitted", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nShould not spawn pi."),
    );
    const store = {
      getSettings: vi.fn().mockResolvedValue({
        testMode: true,
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet-4-5",
        validatorProvider: "project-reviewer-provider",
        validatorModelId: "project-reviewer-model",
      }),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "code", "# prompt",
      "abc123",
      {
        store: store as any,
        taskId: "FN-100",
        taskValidatorProvider: "task-reviewer-provider",
        taskValidatorModelId: "task-reviewer-model",
      },
    );

    expect(store.getSettings).toHaveBeenCalled();
    expect(mockedCreateFnAgent).not.toHaveBeenCalled();
    expect(result.verdict).toBe("APPROVE");
  });

  it("uses the selected workflow reviewer lane after project and global lanes fall through", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nWorkflow reviewer honored."),
    );
    const task = { id: "FN-100", column: "in-review", steps: [] } as any;
    const store = {
      getSettings: vi.fn().mockResolvedValue({
        defaultProvider: "default-provider",
        defaultModelId: "default-model",
      }),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "wf-custom", stepIds: [] })),
      getDefaultWorkflowId: vi.fn(async () => "builtin:coding"),
      getWorkflowDefinition: vi.fn(async (workflowId: string) => workflowId === "wf-custom"
        ? {
            ir: {
              version: "v2",
              name: "Custom",
              columns: [],
              nodes: [],
              edges: [],
              settings: [
                { id: "validatorProvider", name: "Validator provider", type: "string" },
                { id: "validatorModelId", name: "Validator model", type: "string" },
              ],
            },
          }
        : undefined),
      getWorkflowSettingValues: vi.fn((workflowId: string) => workflowId === "wf-custom"
        ? { validatorProvider: "workflow-provider", validatorModelId: "workflow-model" }
        : {}),
      getWorkflowSettingsProjectId: vi.fn(() => "project-1"),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "code", "# prompt", "abc123",
      { store: store as any, taskId: task.id, task },
    );

    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.defaultProvider).toBe("workflow-provider");
    expect(opts.defaultModelId).toBe("workflow-model");
  });

  it("logs reviewer model rows with default thinking effort", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nLooks good."),
    );
    const store = {
      getSettings: vi.fn().mockResolvedValue({}),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    await reviewStep(
      "/tmp/worktree", "FN-100", 1, "Test Step", "plan", "# prompt",
      undefined,
      {
        store: store as any,
        taskId: "FN-100",
        defaultThinkingLevel: "high",
      },
    );

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-100",
      "Reviewer using model: mock-provider/mock-model (thinking effort: high)",
    );
    // FNXC:AgentLog-EntryTypes 2026-07-15-11:20: the marker is a complete standalone message,
    // so it is a `status` row — `text` means "streamed delta fragment" and gets glued to its
    // neighbours with no separator.
    expect(store.appendAgentLog).toHaveBeenCalledWith(
      "FN-100",
      "Reviewer using model: mock-provider/mock-model (thinking effort: high)",
      "status",
      undefined,
      "reviewer",
    );
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

  it("allows same-session reviewer fixes when requested", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nFixed the plan."),
    );
    const store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    await reviewStep(
      "/tmp/worktree", "FN-050", 0, "Plan Review", "plan", "# Task: KB-050",
      undefined,
      { allowInlineFixes: true, store: store as any, taskId: "FN-050" },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.tools).toBe("readonly");
    expect(opts.customTools?.map((tool: any) => tool.name)).toContain("fn_task_prompt_write");
    expect(mockedPromptWithFallback.mock.calls[0][1]).toContain("Same-Session Fix Policy");
    expect(mockedPromptWithFallback.mock.calls[0][1]).toContain("fn_task_prompt_write");
  });

  it("uses coding tools for same-session code review fixes", async () => {
    mockedCreateFnAgent.mockResolvedValue(
      createMockSession("### Verdict: APPROVE\n### Summary\nFixed the code."),
    );

    await reviewStep(
      "/tmp/worktree", "FN-051", 1, "Code Review", "code", "# Task: KB-051",
      undefined,
      { allowInlineFixes: true },
    );

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    const opts = mockedCreateFnAgent.mock.calls[0][0];
    expect(opts.tools).toBe("coding");
    expect(opts.customTools?.map((tool: any) => tool.name)).not.toContain("fn_task_prompt_write");
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

/*
FNXC:TriagePlanReviewConvergence 2026-07-16-19:40:
Prove the spec-gate convergence block is wired through reviewStep -> buildReviewRequest. We drive
the real (module-private) request builder by capturing the prompt string handed to the mocked
session, exactly like the "spec review type" tests above — no test-only export is needed because
the request text is observable at the session seam.
*/
describe("reviewStep — spec convergence wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function captureReviewPrompt(): { getPrompt: () => string } {
    const state = { prompt: "" };
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async (prompt: string) => {
          state.prompt = prompt;
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
    return { getPrompt: () => state.prompt };
  }

  it("omits the convergence block for spec reviews on attempt <= 1 or undefined", async () => {
    const cap = captureReviewPrompt();
    await reviewStep(
      "/tmp/worktree", "FN-CONV", 0, "Spec Review", "spec", "# Task: FN-CONV",
      undefined,
      { priorSpecReviewFeedback: "prior REVISE text", specReviewAttempt: 1 },
    );
    expect(cap.getPrompt()).not.toContain("## Convergence — Plan Review attempt");
    expect(cap.getPrompt()).not.toContain("prior REVISE text");
  });

  it("omits the convergence block for spec reviews when convergence fields are absent", async () => {
    const cap = captureReviewPrompt();
    await reviewStep(
      "/tmp/worktree", "FN-CONV", 0, "Spec Review", "spec", "# Task: FN-CONV",
    );
    expect(cap.getPrompt()).not.toContain("## Convergence — Plan Review attempt");
  });

  it("includes the convergence block + prior feedback + verify-your-own-miss wording at attempt 2", async () => {
    const cap = captureReviewPrompt();
    await reviewStep(
      "/tmp/worktree", "FN-CONV", 0, "Spec Review", "spec", "# Task: FN-CONV",
      undefined,
      { priorSpecReviewFeedback: "PRIOR-REVISE-MARKER: fix the missing Surface Enumeration", specReviewAttempt: 2 },
    );
    const prompt = cap.getPrompt();
    expect(prompt).toContain("## Convergence — Plan Review attempt 2");
    expect(prompt).toContain("PRIOR-REVISE-MARKER: fix the missing Surface Enumeration");
    expect(prompt).toContain("VERIFY each issue you raised previously was addressed");
    expect(prompt).toContain("that is your own earlier miss");
    // Attempt 2 must NOT yet ratchet severity.
    expect(prompt).not.toContain("Severity ratchet (attempt 3+)");
  });

  it("adds the severity ratchet at attempt >= 3", async () => {
    const cap = captureReviewPrompt();
    await reviewStep(
      "/tmp/worktree", "FN-CONV", 0, "Spec Review", "spec", "# Task: FN-CONV",
      undefined,
      { priorSpecReviewFeedback: "prior text", specReviewAttempt: 3 },
    );
    const prompt = cap.getPrompt();
    expect(prompt).toContain("## Convergence — Plan Review attempt 3");
    expect(prompt).toContain("Severity ratchet (attempt 3+)");
  });

  it("never includes the convergence block for code reviews even when convergence fields are passed", async () => {
    const cap = captureReviewPrompt();
    await reviewStep(
      "/tmp/worktree", "FN-CONV", 1, "Code Review", "code", "# prompt", "abc123",
      { priorSpecReviewFeedback: "prior text", specReviewAttempt: 3 } as any,
    );
    expect(cap.getPrompt()).not.toContain("## Convergence — Plan Review attempt");
  });

  it("never includes the convergence block for plan reviews even when convergence fields are passed", async () => {
    const cap = captureReviewPrompt();
    await reviewStep(
      "/tmp/worktree", "FN-CONV", 1, "Plan Review", "plan", "# prompt",
      undefined,
      { priorSpecReviewFeedback: "prior text", specReviewAttempt: 3 } as any,
    );
    expect(cap.getPrompt()).not.toContain("## Convergence — Plan Review attempt");
  });
});

describe("FN-5928 surface-enumeration review-gate wording", () => {
  it("requires spec reviews to block missing or incomplete surface enumeration for bug-fix specs", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain("**Surface enumeration:**");
    expect(DEFAULT_REVIEWER_PROMPT).toMatch(
      /For bug-fix specs and UI-affordance add\/remove specs, is `## Surface Enumeration` present[\s\S]*Missing or incomplete coverage is a blocking REVISE\./,
    );
    expect(DEFAULT_REVIEWER_PROMPT).toContain("desktop + mobile breakpoints/platforms");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("shared hooks/components/modules/helpers");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("bug-fix specs and UI-affordance add/remove specs");
  });

  it("requires code reviews to reject repro-only regression tests for bug fixes", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toMatch(
      /For bug fixes, apply FN-5893 strictly: if the regression test only reproduces the reported case instead of asserting the invariant across the spec's `## Surface Enumeration` surfaces, issue REVISE\./,
    );
    expect(DEFAULT_REVIEWER_PROMPT).toContain("single-surface-only test");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("doesn't verify the invariant across the spec's enumerated surfaces");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("Keep enforcing FN-5893 for bug fixes");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("FN-5787/FN-5789/FN-5803");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("FN-5797/FN-5875/FN-5919");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("FN-5751");
  });

  it("requires spec reviews to block bug-class specs missing symptom verification", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain("**Symptom verification:**");
    expect(DEFAULT_REVIEWER_PROMPT).toMatch(
      /For bug-class\/bug-fix specs only, is `## Symptom Verification` present and complete with \*\*Original symptom\*\*, \*\*Exact reproduction\*\*, and \*\*Assertion it is gone\*\*\?/,
    );
    expect(DEFAULT_REVIEWER_PROMPT).toContain(
      "A bug-class spec whose final verification only checks green build/tests without reproducing the original failure and asserting it no longer occurs is a blocking REVISE under FN-5893",
    );
    expect(DEFAULT_REVIEWER_PROMPT).toContain(
      "Missing, empty, or incomplete `## Symptom Verification` is a blocking REVISE for bug-class specs",
    );
    expect(DEFAULT_REVIEWER_PROMPT).toContain("feature/docs/non-bug specs are not required to carry it");
  });

  it("requires code reviews to reject green-build-only symptom acceptance for bug fixes", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toMatch(
      /For bug-class\/bug-fix specs, also enforce symptom-based acceptance:[\s\S]*final verification only checks green build\/tests without reproducing the original failure condition and asserting it no longer occurs, issue REVISE\./,
    );
    expect(DEFAULT_REVIEWER_PROMPT).toContain("lacks **Original symptom**, **Exact reproduction**, or **Assertion it is gone**");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("Do not require `## Symptom Verification` for feature/docs/non-bug specs");
  });

  it("requires spec/code reviews to enforce surface enumeration for UI-affordance add/remove tasks", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain("leftover shells after removal");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("For bug fixes and UI-affordance add/remove changes");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("UI-affordance removals");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("For UI-affordance add/remove changes, apply the same surface-enumeration strictness");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("FN-6115/FN-6118/FN-6123");
  });

  it("demonstrates the gate firing on a single-component UI-removal spec", () => {
    const singleComponentRemovalSpec =
      "## Mission\nRemove the workflow-row chevron from WorkflowRow.tsx only.";

    expect(singleComponentRemovalSpec).toContain("WorkflowRow.tsx only");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("searches for ALL components rendering the affordance");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("not just the one the user pointed at");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("leftover shells after removal");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("empty button shells");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("Issue REVISE when coverage stops at the single reported surface");
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

    const userComments = [
      {
        id: "user-comment-1",
        text: "User says compact retry must keep this requirement.",
        author: "user" as const,
        createdAt: "2026-06-30T16:00:00.000Z",
        updatedAt: "2026-06-30T16:01:00.000Z",
      },
    ];

    const result = await reviewStep(
      "/tmp/worktree",
      "FN-4082",
      2,
      "Retry review",
      "code",
      promptContent,
      "abc123",
      { store: store as any, taskId: "FN-4082", userComments, allowInlineFixes: true },
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
    expect(secondRequest).toContain("## User Comments");
    expect(secondRequest).toContain("User says compact retry must keep this requirement.");
    expect(firstRequest).toContain("Same-Session Fix Policy");
    expect(secondRequest).toContain("Same-Session Fix Policy");
    expect(secondRequest.match(/## User Comments/g)).toHaveLength(1);
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
      getSettings: vi.fn().mockResolvedValue({
        maxReviewerFallbackRetries: 2,
        maxTotalRetriesBeforeFail: 25,
        validatorFallbackThinkingLevel: "xhigh",
      }),
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
    expect(mockedCreateFnAgent.mock.calls.every(([options]) => options.fallbackThinkingLevel === "xhigh")).toBe(true);
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

describe("default reviewer prompt", () => {
  it("includes subtask breakdown criterion in spec review", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain("Subtask breakdown");
    expect(DEFAULT_REVIEWER_PROMPT).toContain(
      "12+ implementation steps",
    );
  });

  it("biases the reviewer toward keeping tasks whole", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain("The bar for splitting is high");
    expect(DEFAULT_REVIEWER_PROMPT).toContain(
      "Default position:** do NOT flag undersplit",
    );
    expect(DEFAULT_REVIEWER_PROMPT).toContain("12+ implementation steps");
  });

  it("downgrades borderline undersplit findings to non-blocking suggestions", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain(
      "Suggestions** section instead of REVISE",
    );
  });

  it("instructs planner to use fn_task_create for genuinely oversized tasks", () => {
    // The reviewer's REVISE feedback must explicitly direct the planner to
    // create child tasks via fn_task_create rather than just flagging the issue.
    expect(DEFAULT_REVIEWER_PROMPT).toContain("fn_task_create");
    expect(DEFAULT_REVIEWER_PROMPT).toContain(
      "create 2–5 child tasks",
    );
    expect(DEFAULT_REVIEWER_PROMPT).toContain(
      "Not write a parent PROMPT.md",
    );
  });

  it("includes user comment coverage criterion in spec review format", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain("User comment coverage");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("missing coverage is a blocking REVISE");
  });

  it("includes worktree boundary guidance for code reviews", () => {
    expect(DEFAULT_REVIEWER_PROMPT).toContain("Worktree Boundary Review");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("assigned task worktree");
    expect(DEFAULT_REVIEWER_PROMPT).toContain("blocking REVISE");
    expect(DEFAULT_REVIEWER_PROMPT).toContain(".fusion/memory/");
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
      {
        id: "s1",
        text: "Legacy steering: keep compatibility",
        author: "user",
        createdAt: "2026-01-02T10:05:00.000Z",
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
    expect(capturedPrompt).toContain("Legacy steering: keep compatibility");
    expect(capturedPrompt.match(/User Comment Coverage \(MANDATORY\)/g)).toHaveLength(1);
    expect(capturedPrompt).not.toContain("## User Comments");
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
    expect(capturedPrompt).not.toContain("## User Comments");
  });

  it.each(["plan", "code"] as const)("includes user comments for %s reviews without spec coverage gating", async (reviewType) => {
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
      "/tmp/worktree", "FN-050", 1, "Implementation", reviewType,
      "# Task: FN-050\n\n## Mission\nDo something",
      reviewType === "code" ? "abc123" : undefined,
      { userComments },
    );

    expect(capturedPrompt).toContain("## User Comments");
    expect(capturedPrompt).toContain("Some user feedback");
    expect(capturedPrompt.match(/## User Comments/g)).toHaveLength(1);
    expect(capturedPrompt).not.toContain("User Comment Coverage (MANDATORY)");
  });

  it.each(["plan", "code"] as const)("omits the user comments section for %s reviews when no comments are provided", async (reviewType) => {
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
      "/tmp/worktree", "FN-050", 1, "Implementation", reviewType,
      "# Task: FN-050\n\n## Mission\nDo something",
      reviewType === "code" ? "abc123" : undefined,
    );

    expect(capturedPrompt).not.toContain("## User Comments");
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
  // FNXC:SessionSkillContext 2026-07-13: buildSessionSkillContext mockResolvedValue objects MUST include additionalSkillPaths: [] — the production code (reviewer.ts:429) reads skillContext.additionalSkillPaths.length unconditionally when skillContext is truthy; omitting the field crashes with TypeError before createFnAgent is reached.
  vi.mock("../cli-runtime/session-skill-context.js", () => ({
    buildSessionSkillContext: vi.fn(),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes skillSelection to createFnAgent when agentStore and rootDir are provided", async () => {
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/project",
      requestedSkillNames: ["fusion"],
      sessionPurpose: "reviewer",
    }, resolvedSkillNames: ["fusion"], skillSource: "role-fallback", additionalSkillPaths: [] });

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
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/project",
      requestedSkillNames: ["custom-skill", "another-skill"],
      sessionPurpose: "reviewer",
    }, resolvedSkillNames: ["custom-skill", "another-skill"], skillSource: "assigned-agent", additionalSkillPaths: [] });

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
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: undefined, resolvedSkillNames: [], skillSource: "none", additionalSkillPaths: [] });

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
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
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
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    const resolvedNames = ["skill-a", "skill-b", "skill-c"];
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/project",
      requestedSkillNames: resolvedNames,
      sessionPurpose: "reviewer",
    }, resolvedSkillNames: resolvedNames, skillSource: "assigned-agent", additionalSkillPaths: [] });

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
    const { buildSessionSkillContext } = await import("../cli-runtime/session-skill-context.js");
    vi.mocked(buildSessionSkillContext).mockResolvedValue({ skillSelectionContext: {
      projectRootDir: "/tmp/project",
      requestedSkillNames: ["fusion"],
      sessionPurpose: "reviewer",
    }, resolvedSkillNames: ["fusion"], skillSource: "role-fallback", additionalSkillPaths: [] });

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

/*
FNXC:ReviewerProviderErrors 2026-07-15-11:20:
Regression coverage for the reviewer provider-error loop.

## Symptom Verification
Original symptom: a task's Chat tab filled with 14 identical "Reviewer using model: umans/umans-kimi-k2.7" rows and no review text, while the engine kept re-hitting an already-rate-limited provider.
Exact reproduction: the reviewer's prompt rejects with a rate-limit error (the provider condition behind the report).
Assertion it is gone: the rate limit escalates as a typed `ReviewerProviderError` instead of becoming an `UNAVAILABLE` verdict, and exactly ONE session is created — no same-model re-hit, and therefore no repeated marker.

## Surface Enumeration
Provider-error classes: usage-limit, transient (recovered + exhausted), permanent (must keep the existing fallback ladder).
Fallback configurations: configured fallback model AND no configured fallback (the reported case — the "fallback" degrades to a same-model strict-prompt rerun, so a rate limit was re-hit instantly).
Review types: code (blocking) and plan/spec (advisory) share `reviewStep`, so both are asserted.
Budget: `reviewerFallbackRetryCount` must not be burned by an outage.
Marker emission: deduped per model, but a real model change must still emit.
*/
describe("reviewStep — provider errors are not review verdicts", () => {
  const RATE_LIMIT_ERROR = "429 rate_limit_error: too many requests";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockedPromptWithFallback.mockImplementation(async (session: any, prompt: any, options: any) => {
      if (options == null) await session.prompt(prompt);
      else await session.prompt(prompt, options);
    });
  });

  it("escalates a rate limit as ReviewerProviderError instead of an UNAVAILABLE verdict", async () => {
    mockedCreateFnAgent.mockResolvedValue(createMockSession("unused"));
    mockedPromptWithFallback.mockRejectedValue(new Error(RATE_LIMIT_ERROR));

    const error = await reviewStep(
      "/tmp/worktree", "FN-RL", 2, "Rate limited", "code", "# prompt", "abc123", {
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet",
      },
    ).then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(ReviewerProviderError);
    expect((error as ReviewerProviderError).classification).toBe("usage-limit");
    expect((error as ReviewerProviderError).provider).toBe("anthropic");
    // The reported bug: with no configured fallback the ladder re-ran the SAME model
    // immediately, so a 429 spawned a second session (and a second identical marker).
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
  });

  it("does not spend the configured fallback model on a rate limit", async () => {
    mockedCreateFnAgent.mockResolvedValue(createMockSession("unused"));
    mockedPromptWithFallback.mockRejectedValue(new Error(RATE_LIMIT_ERROR));

    await expect(
      reviewStep("/tmp/worktree", "FN-RL2", 2, "Rate limited", "code", "# prompt", "abc123", {
        projectValidatorFallbackProvider: "openai",
        projectValidatorFallbackModelId: "gpt-5-mini",
      }),
    ).rejects.toBeInstanceOf(ReviewerProviderError);

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
  });

  it("escalates a rate limit for advisory plan reviews too, not just blocking code reviews", async () => {
    mockedCreateFnAgent.mockResolvedValue(createMockSession("unused"));
    mockedPromptWithFallback.mockRejectedValue(new Error(RATE_LIMIT_ERROR));

    await expect(
      reviewStep("/tmp/worktree", "FN-RL3", 1, "Plan", "plan", "# prompt", undefined, {}),
    ).rejects.toBeInstanceOf(ReviewerProviderError);

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
  });

  it("does not burn the reviewer fallback retry budget on a provider outage", async () => {
    mockedCreateFnAgent.mockResolvedValue(createMockSession("unused"));
    mockedPromptWithFallback.mockRejectedValue(new Error(RATE_LIMIT_ERROR));

    const store = {
      getSettings: vi.fn().mockResolvedValue({}),
      getTask: vi.fn().mockResolvedValue({ id: "FN-RL4", reviewerFallbackRetryCount: 0, steps: [] }),
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      reviewStep("/tmp/worktree", "FN-RL4", 2, "Rate limited", "code", "# prompt", "abc123", {
        store: store as any,
        taskId: "FN-RL4",
        settings: {} as any,
      }),
    ).rejects.toBeInstanceOf(ReviewerProviderError);

    // The budget bounds BAD REVIEWS. Spending it on an outage would fail healthy tasks.
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-RL4",
      expect.objectContaining({ reviewerFallbackRetryCount: expect.anything() }),
    );
  });

  it("keeps the fallback ladder for a genuine (permanent) reviewer error", async () => {
    mockedCreateFnAgent
      .mockResolvedValueOnce(createMockSession("unused"))
      .mockResolvedValueOnce(createMockSession("### Verdict: REVISE\n### Summary\nRecovered."));
    mockedPromptWithFallback
      .mockRejectedValueOnce(new Error("reviewer produced malformed output"))
      .mockImplementation(async (session: any, prompt: any, options: any) => {
        if (options == null) await session.prompt(prompt);
        else await session.prompt(prompt, options);
      });

    const result = await reviewStep(
      "/tmp/worktree", "FN-PERM", 2, "Retry", "code", "# prompt", "abc123",
      { projectValidatorFallbackProvider: "openai", projectValidatorFallbackModelId: "gpt-5-mini" },
    );

    // A permanent error is a REVIEW problem — the ladder still applies.
    expect(result.verdict).toBe("REVISE");
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
  });

  it("absorbs a flaky network blip by retrying the attempt with backoff", async () => {
    vi.useFakeTimers();
    mockedCreateFnAgent
      .mockResolvedValueOnce(createMockSession("unused"))
      .mockResolvedValueOnce(createMockSession("### Verdict: APPROVE\n### Summary\nRecovered."));
    mockedPromptWithFallback
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockImplementation(async (session: any, prompt: any, options: any) => {
        if (options == null) await session.prompt(prompt);
        else await session.prompt(prompt, options);
      });

    const pending = reviewStep(
      "/tmp/worktree", "FN-NET", 2, "Flaky", "code", "# prompt", "abc123", {},
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    // A network blip must not surface as a failed review or a rate-limit escalation.
    expect(result.verdict).toBe("APPROVE");
    vi.useRealTimers();
  });

  it("escalates as transient once the network retry budget is exhausted", async () => {
    vi.useFakeTimers();
    mockedCreateFnAgent.mockResolvedValue(createMockSession("unused"));
    mockedPromptWithFallback.mockRejectedValue(new Error("ECONNREFUSED connection refused"));

    const pending = reviewStep(
      "/tmp/worktree", "FN-NET2", 2, "Down", "code", "# prompt", "abc123", {},
    ).then(() => null, (err: unknown) => err);
    await vi.advanceTimersByTimeAsync(300_000);
    const error = await pending;

    expect(error).toBeInstanceOf(ReviewerProviderError);
    expect((error as ReviewerProviderError).classification).toBe("transient");
    vi.useRealTimers();
  });
});

/*
FNXC:ReviewerModelMarker 2026-07-15-11:20:
The marker only carries information when the model CHANGES — the dashboard resolves the effective
model from the latest matching row. Re-emitting it per retry is what produced the run-on
"14 entries" card, so dedupe on marker text while keeping a real model switch visible.
*/
describe("reviewStep — model marker emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockedPromptWithFallback.mockImplementation(async (session: any, prompt: any, options: any) => {
      if (options == null) await session.prompt(prompt);
      else await session.prompt(prompt, options);
    });
  });

  function markerStore() {
    return {
      getSettings: vi.fn().mockResolvedValue({}),
      getTask: vi.fn().mockResolvedValue({ id: "FN-MARK", reviewerFallbackRetryCount: 0, steps: [] }),
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
    };
  }

  const markerRows = (store: ReturnType<typeof markerStore>) =>
    store.appendAgentLog.mock.calls.filter((call) => String(call[1]).startsWith("Reviewer using model:"));

  it("emits the model marker once when the same model is retried", async () => {
    // Two same-model sessions (unparseable verdict -> same-model strict-prompt rerun).
    mockedCreateFnAgent
      .mockResolvedValueOnce(createMockSession("no parseable verdict #1"))
      .mockResolvedValueOnce(createMockSession("no parseable verdict #2"));
    const store = markerStore();

    await reviewStep("/tmp/worktree", "FN-MARK", 2, "Marker", "spec", "# prompt", undefined, {
      store: store as any,
      taskId: "FN-MARK",
      settings: {} as any,
    });

    // Two sessions, one marker — the reported symptom was one marker PER session.
    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(2);
    expect(markerRows(store)).toHaveLength(1);
  });

  it("still emits a marker when the reviewer actually switches models", async () => {
    /*
    Tag each session with the model it represents and resolve `describeModel` from the session
    itself. A `mockReturnValueOnce` chain is NOT safe here: `describeModel` is also called by
    agent-session-helpers (its "built-in fallback model" warning), which silently consumes a
    queued value and makes this test assert the wrong thing.
    */
    const taggedSession = (reviewText: string, model: string) => {
      const mock = createMockSession(reviewText);
      mock.session.__testModel = model;
      return mock;
    };
    mockedCreateFnAgent
      .mockResolvedValueOnce(taggedSession("no parseable verdict", "primary-provider/primary-model"))
      .mockResolvedValueOnce(taggedSession("### Verdict: APPROVE\n### Summary\nok", "fallback-provider/fallback-model"));
    const { describeModel } = await import("../pi.js");
    vi.mocked(describeModel).mockImplementation(
      (session: any) => session?.__testModel ?? "mock-provider/mock-model",
    );
    const store = markerStore();

    await reviewStep("/tmp/worktree", "FN-MARK2", 2, "Marker", "spec", "# prompt", undefined, {
      store: store as any,
      taskId: "FN-MARK2",
      settings: {} as any,
      projectValidatorFallbackProvider: "fallback-provider",
      projectValidatorFallbackModelId: "fallback-model",
    });

    // Dedupe is on marker TEXT, so a genuine model switch is never hidden. Assert the actual
    // rows, not just the count — a count-only check would pass even if both rows named the
    // same model, which is exactly the bug this guards.
    expect(markerRows(store).map((call) => call[1])).toEqual([
      "Reviewer using model: primary-provider/primary-model",
      "Reviewer using model: fallback-provider/fallback-model",
    ]);
  });

  it("writes the marker as a standalone status row, never as a streamed text delta", async () => {
    mockedCreateFnAgent.mockResolvedValue(createMockSession("### Verdict: APPROVE\n### Summary\nok"));
    const store = markerStore();

    await reviewStep("/tmp/worktree", "FN-MARK3", 2, "Marker", "code", "# prompt", "abc123", {
      store: store as any,
      taskId: "FN-MARK3",
      settings: {} as any,
    });

    // `text` rows are re-glued with join("") by the renderers; a whole message must be `status`.
    expect(markerRows(store).every((call) => call[2] === "status")).toBe(true);
  });
});
