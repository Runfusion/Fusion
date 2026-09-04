import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  formatModelMarkerDetails: vi.fn((model: string) => model),
  promptWithFallback: vi.fn(async (session: { prompt: (prompt: string) => Promise<void> }, prompt: string) => session.prompt(prompt)),
}));

vi.mock("../agents/agent-session-helpers.js", () => ({
  createResolvedAgentSession: vi.fn(),
  extractRuntimeHint: vi.fn().mockReturnValue(undefined),
  resolveValidatorSessionModel: vi.fn().mockReturnValue({ provider: "mock-provider", modelId: "mock-model" }),
  resolveValidatorFallbackThinkingLevel: vi.fn().mockReturnValue(undefined),
}));

import { BUILTIN_AGENT_PROMPTS, resolveAgentPrompt, type Settings, type TaskDetail, type TaskStore, type WorkflowIrNode } from "@fusion/core";
import {
  parseWorkflowStepOutput,
  workflowStepMissingVerdictNotice,
} from "../executor.js";
import { createResolvedAgentSession } from "../agents/agent-session-helpers.js";
import { persistWorkspaceCodeReviewApproval } from "../executor/create-authoritative-workflow-seams.js";
import { runGraphCustomNode, toWorkspaceRepoReviewResult } from "../executor/run-graph-custom-node.js";
import { reviewStep } from "../execution/reviewer.js";
import { resolveMockScript } from "../providers/mock-provider.js";

const mockedCreateResolvedAgentSession = vi.mocked(createResolvedAgentSession);

function createReviewSession(reviewText: string) {
  const prompt = vi.fn().mockResolvedValue(undefined);
  return {
    prompt,
    result: {
      session: {
        prompt,
        subscribe: vi.fn().mockImplementation((callback: (event: unknown) => void) => {
          callback({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: reviewText },
          });
        }),
        dispose: vi.fn(),
      },
    } as never,
  };
}

async function reviewText(reviewText: string) {
  mockedCreateResolvedAgentSession.mockImplementation(async () => createReviewSession(reviewText).result);
  return reviewStep("/tmp/worktree", "FN-286", 1, "Mandatory verdict", "plan", "# Plan");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mandatory structured review verdicts", () => {
  it("marks verdict-less reviewer prose as malformed without inventing a rejection", () => {
    const parsed = parseWorkflowStepOutput("The deliverables described in the plan are absent from the diff.");

    expect(parsed).toMatchObject({
      malformed: true,
      malformedReason: "no-verdict",
    });
    expect(parsed).not.toHaveProperty("verdict");
    expect(workflowStepMissingVerdictNotice(parsed.malformedReason!)).toMatch(/JSON verdict object/i);
  });

  it.each([
    "looks good",
    "LGTM",
    "ship it",
    "All good, no blocking issues.",
    "This is acceptable.",
    "Good to merge.",
    "Passes review.",
    "out of scope",
  ])("refuses prose-only approval: %s", (output) => {
    const parsed = parseWorkflowStepOutput(output);
    expect(parsed).toMatchObject({
      malformed: true,
      malformedReason: "prose-approval-without-json",
    });
    expect(parsed).not.toHaveProperty("verdict");
  });

  it("refuses an approving markdown verdict without JSON", () => {
    const parsed = parseWorkflowStepOutput("### Verdict: APPROVE");
    expect(parsed).toMatchObject({ malformed: true, malformedReason: "prose-approval-without-json" });
    expect(parsed).not.toHaveProperty("verdict");
  });

  it("refuses an approval-with-notes status without JSON", () => {
    const parsed = parseWorkflowStepOutput("Status: APPROVE_WITH_NOTES");
    expect(parsed).toMatchObject({ malformed: true, malformedReason: "prose-approval-without-json" });
    expect(parsed).not.toHaveProperty("verdict");
  });

  it("preserves fail-safe prose revision requests", () => {
    expect(parseWorkflowStepOutput("REQUEST REVISION\nfix the gate")).toMatchObject({
      verdict: "REVISE",
      notes: "fix the gate",
    });
    expect(parseWorkflowStepOutput("Verdict: REVISE\n\nFix the plan.")).toMatchObject({
      verdict: "REVISE",
      notes: "Verdict: REVISE\n\nFix the plan.",
    });
  });

  it("keeps structured JSON as the approving authority in all supported shapes", () => {
    for (const output of [
      '{"verdict":"APPROVE","notes":"Reviewed the task."}',
      '```json\n{"verdict":"APPROVE_WITH_NOTES","notes":"Reviewed with notes."}\n```',
      'The review is complete.\n{"verdict":"APPROVE","notes":"Reviewed the diff."}',
    ]) {
      expect(parseWorkflowStepOutput(output)).toMatchObject({
        verdict: expect.stringMatching(/^APPROVE/),
      });
    }
  });

  it.each([
    "APPROVE_ANYTHING",
    "APPROVED",
    "approve",
    " APPROVE ",
    "Approval",
    "approve_with_verdict",
    "REQUEST_REVISION",
    "REJECT",
    "RETHINK",
  ])("refuses non-contract structured workflow verdict: %s", (verdict) => {
    const output = JSON.stringify({ verdict, notes: "Attempted review result." });
    const parsed = parseWorkflowStepOutput(output);
    expect(parsed).toMatchObject({
      malformed: true,
      malformedReason: "unreadable-structured-verdict",
    });
    expect(parsed).not.toHaveProperty("verdict");
  });

  it("keeps genuine skill work output verdict-free when no verdict is required", () => {
    expect(parseWorkflowStepOutput("native skill output", { requireVerdict: false }))
      .toEqual({ output: "native skill output" });
  });

  it("returns UNAVAILABLE for bare approving prose", async () => {
    await expect(reviewText("looks good")).resolves.toMatchObject({ verdict: "UNAVAILABLE" });
  });

  it("returns UNAVAILABLE for an approving prose heading", async () => {
    await expect(reviewText("### Verdict: APPROVE\n### Summary\nLooks good."))
      .resolves.toMatchObject({ verdict: "UNAVAILABLE" });
  });

  it.each([
    "Verdict: APPROVE",
    "Decision: APPROVE",
  ])("returns UNAVAILABLE for an approving prose line: %s", async (output) => {
    await expect(reviewText(output)).resolves.toMatchObject({ verdict: "UNAVAILABLE" });
  });

  it("preserves prose downgrade precedence over quoted JSON examples", async () => {
    await expect(reviewText('## Verdict: REVISE\nExample: {"verdict":"APPROVE"}'))
      .resolves.toMatchObject({ verdict: "REVISE" });
    await expect(reviewText("### Verdict: RETHINK"))
      .resolves.toMatchObject({ verdict: "RETHINK" });
  });

  it("uses trailing structured JSON as the reviewer lane authority", async () => {
    await expect(reviewText('### Verdict: APPROVE\n### Summary\nLooks good.\n{"verdict":"APPROVE","notes":"Reviewed the plan."}'))
      .resolves.toMatchObject({ verdict: "APPROVE" });
    await expect(reviewText('{"verdict":"APPROVE_WITH_NOTES","notes":"Reviewed with notes."}'))
      .resolves.toMatchObject({ verdict: "APPROVE" });
    await expect(reviewText('### Verdict: APPROVE\n### Summary\nA fix is needed.\n{"verdict":"REVISE","notes":"Fix the plan."}'))
      .resolves.toMatchObject({ verdict: "REVISE" });
  });

  it.each([
    "APPROVE_ANYTHING",
    "APPROVED",
    "approve",
    " APPROVE ",
    "Approval",
    "approve_with_verdict",
    "REQUEST_REVISION",
    "REJECT",
  ])("returns UNAVAILABLE for non-contract structured reviewer verdict: %s", async (verdict) => {
    await expect(reviewText(JSON.stringify({ verdict, notes: "Attempted review result." })))
      .resolves.toMatchObject({ verdict: "UNAVAILABLE" });
  });

  it("requires the trailing JSON contract in every default and strict reviewer format", async () => {
    const defaultPrompt = resolveAgentPrompt("reviewer");
    const strictPrompt = resolveAgentPrompt("reviewer", {
      roleAssignments: { reviewer: "strict-reviewer" },
    });
    for (const prompt of [defaultPrompt, strictPrompt]) {
      expect(prompt.match(/### Authoritative Verdict/g)).toHaveLength(3);
      expect(prompt.match(/"verdict":"APPROVE\|APPROVE_WITH_NOTES\|REVISE\|RETHINK"/g)).toHaveLength(3);
      expect(prompt.match(/response with no verdict object is treated as a failed review and is never an approval/g)).toHaveLength(3);
    }
    expect(BUILTIN_AGENT_PROMPTS.find((template) => template.id === "strict-reviewer")?.prompt).toBe(strictPrompt);

    const first = createReviewSession("No verdict object was emitted.");
    const second = createReviewSession('{"verdict":"APPROVE","notes":"Recovered with structured output."}');
    mockedCreateResolvedAgentSession
      .mockResolvedValueOnce(first.result)
      .mockResolvedValueOnce(second.result);
    await expect(reviewStep("/tmp/worktree", "FN-286", 1, "Mandatory verdict", "plan", "# Plan"))
      .resolves.toMatchObject({ verdict: "APPROVE" });
    expect(second.prompt).toHaveBeenCalledWith(expect.stringContaining("End your response with exactly one trailing JSON object"));
  });

  it("keeps the mock reviewer approving through the structured JSON strategy", async () => {
    let output = "";
    await resolveMockScript({ sessionPurpose: "reviewer" }).run({
      sessionPurpose: "reviewer",
      prompt: "review",
      tools: [],
      options: { onText: (text: string) => { output += text; } } as never,
      invokeTool: vi.fn(),
    });

    expect(output).toContain('"verdict":"APPROVE"');
    await expect(reviewText(output)).resolves.toMatchObject({ verdict: "APPROVE" });
  });

  it("forwards the verdict requirement through the graph custom-node context", async () => {
    const task = {
      id: "FN-286",
      title: "Mandatory verdict",
      description: "fixture",
      column: "in-progress",
      priority: "normal",
      steps: [],
      currentStep: 0,
      worktree: "/tmp/fn-286",
    } as TaskDetail;
    const executeWorkflowStep = vi.fn().mockResolvedValue({
      success: true,
      output: "transport succeeded",
      verdictRequired: true,
    });
    const deps = {
      store: {
        getTask: vi.fn().mockResolvedValue(task),
        logEntry: vi.fn().mockResolvedValue(undefined),
      },
      rootDir: "/tmp",
      workspaceConfig: null,
      options: {},
      graphUnattendedRuns: new Set<string>(),
      getRunContextFor: () => undefined,
      adoptColumnAgentForNode: vi.fn().mockResolvedValue(undefined),
      buildInjectedRuntimeEnv: vi.fn().mockResolvedValue({ env: {}, pathEntryCount: 0, injectedKeyCount: 0 }),
      ensureGraphCustomNodeWorktree: vi.fn().mockResolvedValue(task),
      executeScriptWorkflowStep: vi.fn(),
      executeWorkflowStep,
      pauseForCliApproval: vi.fn(),
      resolveWorkflowInputMarkerForGraphNode: vi.fn().mockResolvedValue(undefined),
      runAwaitInputNode: vi.fn(),
      runCliAgentNode: vi.fn(),
      runRawCliCommand: vi.fn(),
      runConfiguredCommand: vi.fn(),
    };
    const node = {
      id: "review-step",
      kind: "prompt",
      config: { name: "Review", prompt: "Review the work", gateMode: "advisory" },
    } as WorkflowIrNode;

    const result = await runGraphCustomNode(
      deps as never,
      node,
      task,
      {} as Settings,
      "custom-review",
    );

    expect(result.contextPatch).toMatchObject({ verdictRequired: true });
  });

  it("does not fabricate workspace approval for a verdict-required success", () => {
    expect(toWorkspaceRepoReviewResult({
      success: true,
      verdictRequired: true,
      output: "The deliverables are absent.",
    })).toMatchObject({ verdict: "UNAVAILABLE", retryable: true });
    expect(toWorkspaceRepoReviewResult({ success: true, output: "script passed" }))
      .toMatchObject({ verdict: "APPROVE", retryable: false });
    expect(toWorkspaceRepoReviewResult({ success: true, verdict: "APPROVE", verdictRequired: true, output: "reviewed" }))
      .toMatchObject({ verdict: "APPROVE", retryable: false });
  });

  it("publishes workspace evidence only for a JSON-authored reviewer approval", async () => {
    const publishWorkspaceCodeReviewEvidence = vi.fn().mockResolvedValue({ published: true });
    const store = {
      getTask: vi.fn().mockResolvedValue({ repositoryScope: { revision: 7 } }),
      publishWorkspaceCodeReviewEvidence,
    } as unknown as TaskStore;

    const proseOnly = await reviewText("### Verdict: APPROVE\n### Summary\nLooks good.");
    await expect(persistWorkspaceCodeReviewApproval(store, "FN-286", {
      ...proseOnly,
      repositoryScopeRevision: 7,
      repositoryDiffFingerprints: { packages: "sha256:prose" },
    })).resolves.toMatchObject({ expected: false, published: false });
    expect(publishWorkspaceCodeReviewEvidence).not.toHaveBeenCalled();

    const structured = await reviewText('### Verdict: APPROVE\n{"verdict":"APPROVE","notes":"Reviewed packages."}');
    await expect(persistWorkspaceCodeReviewApproval(store, "FN-286", {
      ...structured,
      repositoryScopeRevision: 7,
      repositoryDiffFingerprints: { packages: "sha256:json" },
    })).resolves.toMatchObject({ expected: true, published: true });
    expect(publishWorkspaceCodeReviewEvidence).toHaveBeenCalledOnce();
  });
});
