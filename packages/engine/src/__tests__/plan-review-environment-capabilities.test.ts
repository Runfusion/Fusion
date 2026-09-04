import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockProbeEnvironmentCapabilities } = vi.hoisted(() => ({
  mockProbeEnvironmentCapabilities: vi.fn(),
}));

vi.mock("../environment/environment-capabilities.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../environment/environment-capabilities.js")>();
  return {
    ...actual,
    probeEnvironmentCapabilities: mockProbeEnvironmentCapabilities,
  };
});

import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

type CapturedSession = {
  systemPrompt?: string;
};

function captureSession() {
  const holder: { last?: CapturedSession } = {};
  mockedCreateFnAgent.mockImplementation(async (options: any) => {
    holder.last = { systemPrompt: options.systemPrompt };
    const listeners: Array<(event: any) => void> = [];
    const output = '{"verdict":"APPROVE","notes":"Reviewed the supplied scope and found it executable.","findings":[]}';
    return {
      session: {
        state: {},
        subscribe: (listener: (event: any) => void) => {
          listeners.push(listener);
          return () => undefined;
        },
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
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
      },
    };
  });
  return holder;
}

function task() {
  return {
    id: "FN-243",
    title: "Environment-aware planning",
    description: "Use an available runtime",
    column: "todo" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-243",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function step(name = "Plan Review") {
  return {
    id: name === "Plan Review" ? "graph:plan-review-step" : "graph:ordinary-step",
    name,
    description: "",
    mode: "prompt",
    phase: "pre-merge",
    gateMode: name === "Plan Review" ? "gate" : "advisory",
    prompt: name === "Plan Review" ? "Review the plan." : "Inspect the task.",
    toolMode: "readonly",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeExecutor() {
  const store = createMockStore();
  store.getTask.mockResolvedValue(task());
  store.getTaskDocument = vi.fn(async (_id: string, key: string) =>
    key === "PROMPT.md"
      ? { content: "# Task: FN-243\n\n## Steps\n\n### Step 0: Preflight\n- [ ] Verify" }
      : undefined,
  );
  return {
    executor: new TaskExecutor(store as any, "/tmp/test", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
    } as any),
  };
}

describe("Plan Review environment capability injection", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockProbeEnvironmentCapabilities.mockReset();
  });

  it("injects a healthy capability block after the embedded plan", async () => {
    mockProbeEnvironmentCapabilities.mockResolvedValue({
      capabilities: [
        { name: "node", available: true },
        { name: "python3", available: false },
      ],
      degraded: false,
    });
    const { executor } = makeExecutor();
    const captured = captureSession();

    const result = await (executor as any).executeWorkflowStep(task(), step(), "/tmp/wt", {});

    expect(result.success).toBe(true);
    expect(captured.last?.systemPrompt).toContain("Plan Review Scope:");
    expect(captured.last?.systemPrompt).toContain("## Environment Capabilities");
    expect(captured.last?.systemPrompt).toContain("Unavailable commands: python3");
    expect(captured.last?.systemPrompt?.indexOf("## Environment Capabilities"))
      .toBeGreaterThan(captured.last?.systemPrompt?.indexOf("--- END PROMPT.md ---") ?? -1);
  });

  it("omits a degraded capability probe without failing Plan Review", async () => {
    mockProbeEnvironmentCapabilities.mockResolvedValue({ capabilities: [], degraded: true });
    const { executor } = makeExecutor();
    const captured = captureSession();

    const result = await (executor as any).executeWorkflowStep(task(), step(), "/tmp/wt", {});

    expect(result.success).toBe(true);
    expect(captured.last?.systemPrompt).toContain("Plan Review Scope:");
    expect(captured.last?.systemPrompt).not.toContain("## Environment Capabilities");
  });

  it("does not probe or inject capabilities for a non-Plan-Review step", async () => {
    mockProbeEnvironmentCapabilities.mockResolvedValue({
      capabilities: [{ name: "python3", available: false }],
      degraded: false,
    });
    const { executor } = makeExecutor();
    const captured = captureSession();

    const result = await (executor as any).executeWorkflowStep(
      task(),
      step("Implementation Prompt"),
      "/tmp/wt",
      {},
    );

    expect(result.success).toBe(true);
    expect(mockProbeEnvironmentCapabilities).not.toHaveBeenCalled();
    expect(captured.last?.systemPrompt).not.toContain("## Environment Capabilities");
  });
});
