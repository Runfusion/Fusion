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
  defaultProvider?: string;
  defaultModelId?: string;
};

function captureSession(output = '{"verdict":"APPROVE","notes":""}'): { last?: CapturedSession } {
  const holder: { last?: CapturedSession } = {};
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    holder.last = {
      defaultProvider: opts.defaultProvider,
      defaultModelId: opts.defaultModelId,
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
      defaultProvider: "anthropic",
      defaultModelId: "claude-3-5-sonnet",
    });

    expect(captured).toMatchObject({
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });
    expect(captured).not.toMatchObject({
      defaultProvider: "anthropic",
      defaultModelId: "claude-3-5-sonnet",
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
