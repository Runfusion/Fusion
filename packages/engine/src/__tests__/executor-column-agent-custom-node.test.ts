// Column-agent custom-node resolution (plan U3, R2/R3/R4/R8, KTD-2/KTD-3/KTD-6).
//
// `runGraphCustomNode` synthesizes a `WorkflowStep` and runs it on the proven
// WorkflowStep machinery. The seam wiring (maybeExecuteWorkflowGraph) resolves
// the per-node column-agent binding and threads it in as a parameter. These
// tests call `runGraphCustomNode` directly with that binding and assert the
// synthesized step's model/persona plus the audit log entries — mirroring the
// established executor harness (executor-workflow-step-scope.test.ts): build a
// real TaskExecutor over a mock store and spy on `executeWorkflowStep` /
// `executeScriptWorkflowStep` to capture the synthesized step.

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { WorkflowColumnAgent } from "@fusion/core";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-col",
    name: "Column Agent",
    soul: "I am the senior reviewer.",
    instructionsText: "Always be thorough.",
    runtimeConfig: { executorProvider: "anthropic", executorModelId: "claude-col" },
    ...overrides,
  };
}

function makeExecutor(store: ReturnType<typeof createMockStore>, agent: unknown | null) {
  const agentStore = {
    getAgent: vi.fn().mockResolvedValue(agent),
  };
  const executor = new TaskExecutor(store as any, "/tmp/test", { agentStore } as any);
  return { executor, agentStore };
}

/** Spy both session-running paths; return the captured synthesized step. */
function spyStep(executor: TaskExecutor) {
  const captured: { step?: any } = {};
  vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
    captured.step = args[1];
    return { success: true, output: "ok" };
  });
  vi.spyOn(executor as any, "executeScriptWorkflowStep").mockImplementation(async (...args: any[]) => {
    captured.step = args[1];
    return { success: true, output: "ok" };
  });
  return captured;
}

function loggedLines(store: ReturnType<typeof createMockStore>): string[] {
  return store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
}

const OVERRIDE: WorkflowColumnAgent = { agentId: "agent-col", mode: "override" };
const DEFER: WorkflowColumnAgent = { agentId: "agent-col", mode: "defer" };

describe("runGraphCustomNode column-agent resolution (plan U3)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("override column: node with own cfg.agentId runs as column agent (model+persona) and logs substitution+mode", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({ id: "FN-001", worktree: "/tmp/wt", log: [] } as any);
    const { executor, agentStore } = makeExecutor(store, makeAgent());
    const captured = spyStep(executor);

    const node = {
      id: "review",
      kind: "prompt",
      column: "review",
      config: {
        executor: "agent",
        agentId: "node-own-agent",
        modelProvider: "openai",
        modelId: "gpt-node",
        prompt: "Review the diff.",
      },
    };

    const result = await (executor as any).runGraphCustomNode(node, { id: "FN-001" }, {}, OVERRIDE);

    expect(result.outcome).toBe("success");
    // Column agent fetched (not the node's own agent).
    expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
    // Column agent's model wins over the node's own pair.
    expect(captured.step.modelProvider).toBe("anthropic");
    expect(captured.step.modelId).toBe("claude-col");
    // Column agent's persona (soul + instructionsText) prepended to the prompt.
    expect(captured.step.prompt).toContain("I am the senior reviewer.");
    expect(captured.step.prompt).toContain("Always be thorough.");
    expect(captured.step.prompt).toContain("Review the diff.");
    // Audit log records substitution + mode.
    expect(
      loggedLines(store).some((l) => l.includes("running as column agent 'agent-col' (override)")),
    ).toBe(true);
  });

  it("defer column: node with own cfg.agentId keeps it; bare node adopts the column agent", async () => {
    // (a) own agentId present → defer yields own settings, column agent untouched.
    {
      const store = createMockStore();
      store.getTask.mockResolvedValue({ id: "FN-001", worktree: "/tmp/wt", log: [] } as any);
      const nodeOwnAgent = makeAgent({ id: "node-own-agent", soul: "node persona", instructionsText: "", runtimeConfig: { executorProvider: "openai", executorModelId: "gpt-node" } });
      const { executor, agentStore } = makeExecutor(store, nodeOwnAgent);
      const captured = spyStep(executor);

      const node = {
        id: "review",
        kind: "prompt",
        column: "review",
        config: { executor: "agent", agentId: "node-own-agent", prompt: "Do it." },
      };
      await (executor as any).runGraphCustomNode(node, { id: "FN-001" }, {}, DEFER);

      // Own agent fetched, NOT the column agent.
      expect(agentStore.getAgent).toHaveBeenCalledWith("node-own-agent");
      expect(agentStore.getAgent).not.toHaveBeenCalledWith("agent-col");
      expect(captured.step.modelProvider).toBe("openai");
      expect(captured.step.modelId).toBe("gpt-node");
      expect(
        loggedLines(store).some((l) => l.includes("running as column agent")),
      ).toBe(false);
    }

    // (b) bare node (no own agent/model) → defer adopts the column agent.
    {
      const store = createMockStore();
      store.getTask.mockResolvedValue({ id: "FN-001", worktree: "/tmp/wt", log: [] } as any);
      const { executor, agentStore } = makeExecutor(store, makeAgent());
      const captured = spyStep(executor);

      const node = { id: "review", kind: "prompt", column: "review", config: { prompt: "Plain." } };
      await (executor as any).runGraphCustomNode(node, { id: "FN-001" }, {}, DEFER);

      expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
      expect(captured.step.modelProvider).toBe("anthropic");
      expect(captured.step.modelId).toBe("claude-col");
      expect(captured.step.prompt).toContain("I am the senior reviewer.");
      expect(
        loggedLines(store).some((l) => l.includes("running as column agent 'agent-col' (defer)")),
      ).toBe(true);
    }
  });

  it("override column: bare node adopts the column agent (own-absent cell)", async () => {
    // override × own-absent: nothing to supersede, the column agent is adopted.
    const store = createMockStore();
    store.getTask.mockResolvedValue({ id: "FN-001", worktree: "/tmp/wt", log: [] } as any);
    const { executor, agentStore } = makeExecutor(store, makeAgent());
    const captured = spyStep(executor);

    const node = { id: "review", kind: "prompt", column: "review", config: { prompt: "Plain." } };
    const result = await (executor as any).runGraphCustomNode(node, { id: "FN-001" }, {}, OVERRIDE);

    expect(result.outcome).toBe("success");
    expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
    expect(captured.step.modelProvider).toBe("anthropic");
    expect(captured.step.modelId).toBe("claude-col");
    expect(captured.step.prompt).toContain("I am the senior reviewer.");
    expect(
      loggedLines(store).some((l) => l.includes("running as column agent 'agent-col' (override)")),
    ).toBe(true);
  });

  it("missing column agent in registry → logged, node falls back, step still executes", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({ id: "FN-001", worktree: "/tmp/wt", log: [] } as any);
    // agentStore returns null for the column agent.
    const { executor } = makeExecutor(store, null);
    const captured = spyStep(executor);

    const node = { id: "review", kind: "prompt", column: "review", config: { prompt: "Plain." } };
    const result = await (executor as any).runGraphCustomNode(node, { id: "FN-001" }, {}, OVERRIDE);

    expect(result.outcome).toBe("success");
    // No column-agent model adopted (agent missing) → step has no model pair.
    expect(captured.step.modelProvider).toBeUndefined();
    expect(captured.step.modelId).toBeUndefined();
    expect(
      loggedLines(store).some((l) => l.includes("column agent 'agent-col' not found")),
    ).toBe(true);
  });

  it("column agent lookup THROWS (store/agentStore error) → node still succeeds, 'lookup failed' logged (R8)", async () => {
    // adoptColumnAgentForNode is best-effort: an agentStore.getAgent rejection must
    // be swallowed and the node must fall back to node/default resolution rather
    // than the graph node failing.
    const store = createMockStore();
    store.getTask.mockResolvedValue({ id: "FN-001", worktree: "/tmp/wt", log: [] } as any);
    const agentStore = {
      getAgent: vi.fn().mockRejectedValue(new Error("agent store unavailable")),
    };
    const executor = new TaskExecutor(store as any, "/tmp/test", { agentStore } as any);
    const captured = spyStep(executor);

    const node = { id: "review", kind: "prompt", column: "review", config: { prompt: "Plain." } };
    const result = await (executor as any).runGraphCustomNode(node, { id: "FN-001" }, {}, OVERRIDE);

    // Node did NOT fail despite the lookup throwing.
    expect(result.outcome).toBe("success");
    // No column-agent model adopted (lookup failed) → node falls back.
    expect(captured.step.modelProvider).toBeUndefined();
    expect(captured.step.modelId).toBeUndefined();
    // The catch-path fallback audit fired.
    expect(
      loggedLines(store).some(
        (l) => l.includes("column agent 'agent-col' lookup failed") && l.includes("falling back"),
      ),
    ).toBe(true);
  });

  it("node with no declared column → untouched resolution even when a binding is passed as undefined", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({ id: "FN-001", worktree: "/tmp/wt", log: [] } as any);
    const { executor, agentStore } = makeExecutor(store, makeAgent());
    const captured = spyStep(executor);

    // No declared column → the seam wiring resolves no binding (undefined).
    const node = {
      id: "review",
      kind: "prompt",
      config: { executor: "model", modelProvider: "openai", modelId: "gpt-node", prompt: "Plain." },
    };
    await (executor as any).runGraphCustomNode(node, { id: "FN-001" }, {}, undefined);

    // Column agent never fetched; node's own model preserved.
    expect(agentStore.getAgent).not.toHaveBeenCalled();
    expect(captured.step.modelProvider).toBe("openai");
    expect(captured.step.modelId).toBe("gpt-node");
    expect(loggedLines(store).some((l) => l.includes("column agent"))).toBe(false);
  });

  it("CLI-executor node (raw command) in override column → mechanics unchanged, audit notes the skip", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({ id: "FN-001", worktree: "/tmp/wt", log: [] } as any);
    store.isWorkflowCliCommandApproved = vi.fn().mockResolvedValue(true);
    const { executor, agentStore } = makeExecutor(store, makeAgent());
    // Raw CLI runs runRawCliCommand, not a session — stub it.
    const rawSpy = vi.spyOn(executor as any, "runRawCliCommand").mockResolvedValue({ success: true });

    const node = {
      id: "lint",
      kind: "script",
      column: "review",
      config: { executor: "cli", cliCommand: "npm run lint", cliSkipApproval: true, prompt: "" },
    };
    const result = await (executor as any).runGraphCustomNode(node, { id: "FN-001" }, {}, OVERRIDE);

    expect(result.outcome).toBe("success");
    // Raw CLI mechanics unchanged: command still ran.
    expect(rawSpy).toHaveBeenCalled();
    // Column agent NOT fetched/adopted for raw CLI execution.
    expect(agentStore.getAgent).not.toHaveBeenCalled();
    // Audit explains the skip.
    expect(
      loggedLines(store).some(
        (l) =>
          l.includes("column agent 'agent-col' (override) not applied") &&
          l.includes("raw CLI execution runs no session"),
      ),
    ).toBe(true);
  });
});
