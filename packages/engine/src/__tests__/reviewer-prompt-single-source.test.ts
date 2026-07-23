import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  resolveAgentPrompt,
  resolveSeamPromptFromIr,
  type WorkflowIr,
} from "@fusion/core";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  formatModelMarkerDetails: vi.fn((model: string) => model),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
}));

import { reviewStep } from "../execution/reviewer.js";
import { createFnAgent } from "../pi.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);

function createMockSession(reviewText = "### Verdict: APPROVE\n### Summary\nLooks good.") {
  return {
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
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

function createStore(workflowId = "builtin:coding", customIr?: WorkflowIr) {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getTaskWorkflowSelection: vi.fn().mockReturnValue({ workflowId, stepIds: [] }),
    getWorkflowDefinition: vi.fn().mockImplementation(async (id: string) => {
      if (customIr && id === workflowId) return { ir: customIr };
      return undefined;
    }),
  } as any;
}

async function captureReviewerSystemPrompt(options: Parameters<typeof reviewStep>[7] = {}) {
  mockedCreateFnAgent.mockResolvedValue(createMockSession());
  await reviewStep(
    "/tmp/worktree",
    "FN-6235",
    1,
    "Review prompt source",
    "plan",
    "# Plan",
    undefined,
    options,
  );
  return mockedCreateFnAgent.mock.calls[0][0].systemPrompt as string;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reviewer prompt single source", () => {
  it("does not reintroduce an engine reviewer policy constant", () => {
    const reviewerSource = readFileSync(
      resolve(fileURLToPath(new URL("..", import.meta.url)), "reviewer.ts"),
      "utf8",
    );

    expect(reviewerSource).not.toMatch(/export const REVIEWER_SYSTEM_PROMPT\s*=/);
    expect(reviewerSource).not.toMatch(/export const [A-Z_]*REVIEWER[A-Z_]*SYSTEM_PROMPT\s*=/);
  });

  it("keeps builtin coding review seam byte-identical to the default reviewer prompt", () => {
    expect(resolveSeamPromptFromIr(BUILTIN_CODING_WORKFLOW_IR, "review")).toBe(resolveAgentPrompt("reviewer"));
  });

  it("uses the builtin coding IR review-node prompt when no user override is set", async () => {
    const systemPrompt = await captureReviewerSystemPrompt({ store: createStore() });

    expect(systemPrompt).toBe(resolveSeamPromptFromIr(BUILTIN_CODING_WORKFLOW_IR, "review"));
  });

  it("uses a selected custom workflow review-node prompt", async () => {
    const customIr: WorkflowIr = {
      version: "v1",
      name: "custom-reviewer",
      nodes: [
        { id: "start", kind: "start" },
        { id: "review", kind: "prompt", config: { seam: "review", prompt: "custom workflow reviewer prompt" } },
      ],
      edges: [],
    };

    const systemPrompt = await captureReviewerSystemPrompt({ store: createStore("WF-review", customIr) });

    expect(systemPrompt).toBe("custom workflow reviewer prompt");
  });

  it("preserves reviewer user-override precedence over workflow IR prompts", async () => {
    const customIr: WorkflowIr = {
      version: "v1",
      name: "custom-reviewer",
      nodes: [
        { id: "review", kind: "prompt", config: { seam: "review", prompt: "workflow prompt should not win" } },
      ],
      edges: [],
    };

    const systemPrompt = await captureReviewerSystemPrompt({
      store: createStore("WF-review", customIr),
      agentPrompts: {
        templates: [{
          id: "custom-reviewer",
          name: "Custom Reviewer",
          description: "Project reviewer override",
          role: "reviewer",
          prompt: "user override reviewer prompt",
        }],
        roleAssignments: { reviewer: "custom-reviewer" },
      },
    });

    expect(systemPrompt).toBe("user override reviewer prompt");
  });

  it("falls back to a non-empty default reviewer prompt when no store is provided", async () => {
    const systemPrompt = await captureReviewerSystemPrompt();

    expect(systemPrompt).toBe(resolveAgentPrompt("reviewer"));
    expect(systemPrompt.trim().length).toBeGreaterThan(0);
  });

  it.each(["plan", "code", "spec"] as const)("uses the same resolved base prompt for %s reviews", async (reviewType) => {
    mockedCreateFnAgent.mockResolvedValue(createMockSession());
    await reviewStep(
      "/tmp/worktree",
      "FN-6235",
      1,
      "Review prompt source",
      reviewType,
      "# Prompt",
      undefined,
      { store: createStore() },
    );

    expect(mockedCreateFnAgent.mock.calls[0][0].systemPrompt).toBe(resolveAgentPrompt("reviewer"));
  });
});
