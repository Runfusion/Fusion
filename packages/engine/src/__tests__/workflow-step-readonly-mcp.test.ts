import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import type { WorkflowIrNode } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

type CapturedSession = {
  tools?: "coding" | "readonly";
  allowMcpToolsInReadonly?: boolean;
  readonlyMcpServerAllowlist?: string[];
};

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-9232",
    title: "Readonly MCP workflow step",
    description: "Exercise graph prompt policy forwarding.",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-9232",
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

function captureSession() {
  const captured: CapturedSession[] = [];
  mockedCreateFnAgent.mockImplementation(async (options: CapturedSession) => {
    captured.push({
      tools: options.tools,
      allowMcpToolsInReadonly: options.allowMcpToolsInReadonly,
      readonlyMcpServerAllowlist: options.readonlyMcpServerAllowlist,
    });
    return {
      session: {
        state: {},
        subscribe: vi.fn(() => () => {}),
        prompt: vi.fn(),
        dispose: vi.fn(),
      },
    };
  });
  return captured;
}

function makeExecutor() {
  const store = createMockStore();
  store.getTask.mockImplementation(async (id: string) => task({ id }));
  store.getSettings.mockResolvedValue({ reviewerInlineFixes: true });
  return {
    store,
    executor: new TaskExecutor(store as any, "/tmp/test", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
    } as any),
  };
}

async function runGraphPrompt(config: Record<string, unknown>) {
  const { executor } = makeExecutor();
  const captured = captureSession();
  const node: WorkflowIrNode = { id: "readonly-mcp", kind: "prompt", config: { prompt: "Inspect the repository.", ...config } };

  await (executor as any).runGraphCustomNode(node, task(), {}, undefined);
  return captured.at(-1);
}

describe("workflow-step readonly MCP policy", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation(() => Buffer.from(""));
  });

  it("carries a graph node server declaration through synthesis into the readonly session", async () => {
    await expect(runGraphPrompt({ toolMode: "readonly", readonlyMcpServers: ["nav"] })).resolves.toEqual({
      tools: "readonly",
      allowMcpToolsInReadonly: true,
      readonlyMcpServerAllowlist: ["nav"],
    });
  });

  it.each([
    ["absent", {}],
    ["empty", { readonlyMcpServers: [] }],
    ["blank", { readonlyMcpServers: ["  "] }],
  ])("keeps a %s declaration denied by default", async (_label, config) => {
    await expect(runGraphPrompt({ toolMode: "readonly", ...config })).resolves.toEqual({
      tools: "readonly",
      allowMcpToolsInReadonly: undefined,
      readonlyMcpServerAllowlist: undefined,
    });
  });

  it("does not apply readonly MCP policy after a review prompt is promoted to coding", async () => {
    await expect(runGraphPrompt({
      toolMode: "readonly",
      readonlyMcpServers: ["nav"],
      reviewCanFixInline: true,
    })).resolves.toEqual({
      tools: "coding",
      allowMcpToolsInReadonly: undefined,
      readonlyMcpServerAllowlist: undefined,
    });
  });
});
