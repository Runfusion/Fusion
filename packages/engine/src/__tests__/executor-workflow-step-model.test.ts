import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

type CapturedSession = {
  sessionPurpose?: string;
  defaultProvider?: string;
  defaultModelId?: string;
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultThinkingLevel?: string;
  fallbackThinkingLevel?: string;
};

function captureSession(output = '{"verdict":"APPROVE","notes":""}'): { last?: CapturedSession } {
  const holder: { last?: CapturedSession } = {};
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    holder.last = {
      sessionPurpose: opts.sessionPurpose,
      defaultProvider: opts.defaultProvider,
      defaultModelId: opts.defaultModelId,
      fallbackProvider: opts.fallbackProvider,
      fallbackModelId: opts.fallbackModelId,
      defaultThinkingLevel: opts.defaultThinkingLevel,
      fallbackThinkingLevel: opts.fallbackThinkingLevel,
    };

    const listeners: Array<(event: any) => void> = [];
    const session: any = {
      state: {},
      subscribe: (fn: (event: any) => void) => {
        listeners.push(fn);
        return () => {};
      },
      prompt: vi.fn(async () => {
        for (const fn of listeners) {
          fn({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              partial: output,
              contentIndex: 0,
              delta: output,
            },
          });
        }
      }),
      dispose: vi.fn(),
    };
    return { session };
  });
  return holder;
}

function quietGit() {
  mockedExecSync.mockImplementation(() => Buffer.from(""));
}

function makeExecutor(store: ReturnType<typeof createMockStore>) {
  const agentStore = { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() };
  return new TaskExecutor(store as any, "/tmp/test", { agentStore } as any);
}

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-MODEL-1",
    title: "Model resolution",
    description: "verify model resolution",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-model-1",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function workflowStep(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "step:model",
    name: "Model Step",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "advisory" as const,
    prompt: "Check the model.",
    toolMode: "readonly" as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function runStepWithSettings(
  settings: Record<string, unknown>,
  options: {
    task?: Record<string, unknown>;
    step?: Record<string, unknown>;
  } = {},
) {
  const store = createMockStore();
  store.getSettings.mockResolvedValue(settings);
  const executor = makeExecutor(store);
  const captured = captureSession();

  await (executor as any).executeWorkflowStep(
    baseTask(options.task),
    workflowStep(options.step),
    "/tmp/wt",
    settings,
    undefined,
  );

  return { ...captured.last, logCalls: store.logEntry.mock.calls };
}

describe("executor workflow-step model resolution", () => {
  beforeEach(() => {
    resetExecutorMocks();
    quietGit();
  });

  it("uses the project execution lane instead of the global default when the step has no override", async () => {
    const captured = await runStepWithSettings({
      executionProvider: "openai",
      executionModelId: "gpt-4o",
      executionFallbackProvider: "openai",
      executionFallbackModelId: "gpt-4o-mini",
      executionThinkingLevel: "medium",
      fallbackThinkingLevel: "low",
      defaultProvider: "anthropic",
      defaultModelId: "claude-3-5-sonnet",
    });

    expect(captured).toMatchObject({
      sessionPurpose: "executor",
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      fallbackProvider: "openai",
      fallbackModelId: "gpt-4o-mini",
      defaultThinkingLevel: "medium",
      fallbackThinkingLevel: "low",
    });
    expect(captured).not.toMatchObject({
      defaultProvider: "anthropic",
      defaultModelId: "claude-3-5-sonnet",
    });
  });

  it("routes review-type workflow steps through the validator model lane", async () => {
    const captured = await runStepWithSettings(
      {
        executionProvider: "openai-codex",
        executionModelId: "gpt-5.6-terra",
        validatorProvider: "openai-codex",
        validatorModelId: "gpt-5.6-sol",
        validatorFallbackProvider: "openai-codex",
        validatorFallbackModelId: "gpt-5.6-flash",
        validatorThinkingLevel: "high",
        validatorFallbackThinkingLevel: "low",
      },
      {
        step: {
          id: "graph:code-review-step",
          name: "Code Review",
          optionalGroupId: "code-review",
        },
      },
    );

    expect(captured).toMatchObject({
      sessionPurpose: "executor",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.6-sol",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.6-flash",
      defaultThinkingLevel: "high",
      fallbackThinkingLevel: "low",
    });
  });

  it.each([
    ["inline-fix metadata", { name: "Implementation Check", reviewCanFixInline: true }],
    ["Code Review group metadata", { name: "Implementation Check", optionalGroupId: "code-review" }],
    ["Plan Review identity", { id: "graph:plan-review-step", name: "Plan Review" }],
    ["verification name", { name: "Artifact Verification" }],
  ])("classifies %s as validator-routed", async (_label, step) => {
    await expect(
      runStepWithSettings(
        {
          executionProvider: "executor-provider",
          executionModelId: "executor-model",
          validatorProvider: "validator-provider",
          validatorModelId: "validator-model",
        },
        { step },
      ),
    ).resolves.toMatchObject({
      sessionPurpose: "executor",
      defaultProvider: "validator-provider",
      defaultModelId: "validator-model",
    });
  });

  it("keeps near-match ordinary names on executor lanes", async () => {
    await expect(
      runStepWithSettings(
        {
          executionProvider: "executor-provider",
          executionModelId: "executor-model",
          validatorProvider: "validator-provider",
          validatorModelId: "validator-model",
        },
        { step: { name: "Implementation Overview" } },
      ),
    ).resolves.toMatchObject({
      sessionPurpose: "executor",
      defaultProvider: "executor-provider",
      defaultModelId: "executor-model",
    });
  });

  it("uses selected-workflow validator lanes after project and global validator lanes fall through", async () => {
    await expect(
      runStepWithSettings(
        {
          selectedWorkflowModelLanes: {
            validatorProvider: "workflow-validator-provider",
            validatorModelId: "workflow-validator-model",
            validatorFallbackProvider: "workflow-fallback-provider",
            validatorFallbackModelId: "workflow-fallback-model",
            validatorFallbackThinkingLevel: "low",
          },
          defaultProvider: "default-provider",
          defaultModelId: "default-model",
        },
        { step: { name: "Code Review", optionalGroupId: "code-review" } },
      ),
    ).resolves.toMatchObject({
      defaultProvider: "workflow-validator-provider",
      defaultModelId: "workflow-validator-model",
      fallbackProvider: "workflow-fallback-provider",
      fallbackModelId: "workflow-fallback-model",
      fallbackThinkingLevel: "low",
    });
  });

  it("keeps review step and task overrides ahead of validator-lane settings", async () => {
    await expect(
      runStepWithSettings(
        {
          validatorProvider: "project-validator-provider",
          validatorModelId: "project-validator-model",
          validatorThinkingLevel: "medium",
        },
        {
          task: {
            validatorModelProvider: "task-validator-provider",
            validatorModelId: "task-validator-model",
            validatorThinkingLevel: "high",
            thinkingLevel: "low",
          },
          step: {
            name: "Code Review",
            optionalGroupId: "code-review",
          },
        },
      ),
    ).resolves.toMatchObject({
      defaultProvider: "task-validator-provider",
      defaultModelId: "task-validator-model",
      defaultThinkingLevel: "high",
    });

    await expect(
      runStepWithSettings(
        {
          validatorProvider: "project-validator-provider",
          validatorModelId: "project-validator-model",
        },
        {
          step: {
            name: "Code Review",
            optionalGroupId: "code-review",
            modelProvider: "step-provider",
            modelId: "step-model",
          },
        },
      ),
    ).resolves.toMatchObject({
      defaultProvider: "step-provider",
      defaultModelId: "step-model",
    });
  });

  it.each([
    ["provider only", { modelProvider: "partial-provider" }],
    ["model only", { modelId: "partial-model" }],
  ])("does not mix a %s step override with the validator lane", async (_label, partialOverride) => {
    await expect(
      runStepWithSettings(
        {
          validatorProvider: "validator-provider",
          validatorModelId: "validator-model",
        },
        {
          step: {
            name: "Code Review",
            optionalGroupId: "code-review",
            ...partialOverride,
          },
        },
      ),
    ).resolves.toMatchObject({
      defaultProvider: "validator-provider",
      defaultModelId: "validator-model",
    });
  });

  it("keeps step and task overrides ahead of execution-lane settings", async () => {
    await expect(
      runStepWithSettings(
        {
          executionProvider: "project-exec-provider",
          executionModelId: "project-exec-model",
        },
        {
          step: {
            modelProvider: "step-provider",
            modelId: "step-model",
          },
        },
      ),
    ).resolves.toMatchObject({
      defaultProvider: "step-provider",
      defaultModelId: "step-model",
    });

    await expect(
      runStepWithSettings(
        {
          executionProvider: "project-exec-provider",
          executionModelId: "project-exec-model",
        },
        {
          task: {
            modelProvider: "task-provider",
            modelId: "task-model",
          },
        },
      ),
    ).resolves.toMatchObject({
      defaultProvider: "task-provider",
      defaultModelId: "task-model",
    });
  });

  it("falls through the execution hierarchy without mixing partial pairs", async () => {
    await expect(
      runStepWithSettings({
        executionProvider: "partial-project-provider",
        executionGlobalProvider: "global-exec-provider",
        executionGlobalModelId: "global-exec-model",
        defaultProvider: "global-default-provider",
        defaultModelId: "global-default-model",
      }),
    ).resolves.toMatchObject({
      defaultProvider: "global-exec-provider",
      defaultModelId: "global-exec-model",
    });

    await expect(
      runStepWithSettings({
        executionGlobalModelId: "partial-global-model",
        defaultProviderOverride: "project-default-provider",
        defaultModelIdOverride: "project-default-model",
        defaultProvider: "global-default-provider",
        defaultModelId: "global-default-model",
      }),
    ).resolves.toMatchObject({
      defaultProvider: "project-default-provider",
      defaultModelId: "project-default-model",
    });

    await expect(
      runStepWithSettings({
        defaultProvider: "global-default-provider",
        defaultModelId: "global-default-model",
      }),
    ).resolves.toMatchObject({
      defaultProvider: "global-default-provider",
      defaultModelId: "global-default-model",
    });
  });

  it("forces mock/scripted for workflow steps when test mode is active", async () => {
    await expect(
      runStepWithSettings({
        testMode: true,
        executionProvider: "project-exec-provider",
        executionModelId: "project-exec-model",
        defaultProvider: "anthropic",
        defaultModelId: "claude-3-5-sonnet",
      }),
    ).resolves.toMatchObject({
      defaultProvider: "mock",
      defaultModelId: "scripted",
    });
  });

  it("resolves workflow-step thinking level before task and settings defaults", async () => {
    await expect(
      runStepWithSettings(
        {
          defaultThinkingLevel: "low",
        },
        {
          task: { thinkingLevel: "medium" },
          step: { thinkingLevel: "high" },
        },
      ),
    ).resolves.toMatchObject({ defaultThinkingLevel: "high" });

    await expect(
      runStepWithSettings(
        {
          defaultThinkingLevel: "low",
        },
        {
          task: { thinkingLevel: "medium" },
        },
      ),
    ).resolves.toMatchObject({ defaultThinkingLevel: "medium" });

    await expect(
      runStepWithSettings({ defaultThinkingLevel: "low" }),
    ).resolves.toMatchObject({ defaultThinkingLevel: "low" });
  });

  it("logs workflow-step model rows with thinking effort before override annotations", async () => {
    const primary = await runStepWithSettings(
      {
        defaultThinkingLevel: "high",
        executionProvider: "project-exec-provider",
        executionModelId: "project-exec-model",
      },
      {
        step: {
          modelProvider: "step-provider",
          modelId: "step-model",
        },
      },
    );

    expect(primary.logCalls).toContainEqual([
      "FN-MODEL-1",
      "Workflow step 'Model Step' using model: mock-provider/mock-model (thinking effort: high) (workflow step override)",
    ]);
  });
});
