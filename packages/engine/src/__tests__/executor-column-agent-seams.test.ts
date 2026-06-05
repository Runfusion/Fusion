// Column-agent coding seams: execute + step-execute sessions (plan U4,
// R2/R3/R4/R8, KTD-2/KTD-3/KTD-5/KTD-6).
//
// ─────────────────────────────────────────────────────────────────────────────
// SURFACE-ENUMERATION MATRIX AUDIT (plan U7 / FN-5893)
//
// The invariant is proven across mode × surface × own-settings. Every cell that
// matters has at least one assertion in one of the five column-agent test files;
// this block is the completeness ledger (cell → file → test). `own-present` =
// node cfg.agentId OR complete task model pair; `own-absent` = bare.
//
// resolver = column-agent-resolver.test.ts (core, pure precedence)
// custom   = executor-column-agent-custom-node.test.ts
// seams    = executor-column-agent-seams.test.ts (this file)
// princ    = executor-column-agent-principal.test.ts
//
// SURFACE: custom node ───────────────────────────────────────────────────────
//   override × own-present → custom "override column: node with own cfg.agentId…"
//   override × own-absent  → custom "override column: bare node adopts the column agent"
//   defer    × own-present → custom "defer column: node with own cfg.agentId keeps it…" (a)
//   defer    × own-absent  → custom "defer column: …bare node adopts the column agent" (b)
//
// SURFACE: execute seam ──────────────────────────────────────────────────────
//   override × own-present → seams "override column, task assigned to Y → …X's model"
//   override × own-absent  → seams "override column, bare task (no own settings) → column agent"
//   defer    × own-present → seams "defer column, task with complete modelProvider/modelId…"
//   defer    × own-absent  → seams "defer column, bare task (no own settings) → column agent adopted"
//
// SURFACE: step-execute ───────────────────────────────────────────────────────
//   override × own-present → seams "foreach instance node inherits the foreach's bound column…"
//   override × own-absent  → seams "step-execute override, bare task → column-agent attribution"
//   defer    × own-present → seams "defer column with task own complete model pair → assigned attribution"
//   defer    × own-absent  → seams "step-execute defer, bare task → column-agent attribution adopted"
//
// SURFACE: heartbeat-deferred (principal) ─────────────────────────────────────
//   override × own-present → princ "override column X (allowParallelExecution=false)…defers"
//                            + princ "resumeTaskForAgent…pass 2 re-dispatches it"
//   override × own-absent  → princ "two tasks bound to different column agents…" (bare tasks)
//   defer    × own-present → princ "defer column with task own complete model pair → X NOT effective, pass 2 does not fire"
//   defer    × own-absent  → resolver "defer × bare → column agent wins" (gate input);
//                            the deferral gate consumes resolveEffectivePrincipalId, exercised override-side above
//
// SURFACE: missing-agent fallback ─────────────────────────────────────────────
//   custom (override) → custom "missing column agent in registry → logged, node falls back…"
//   execute seam      → seams "column agent missing from registry at seam time → fallback…"
//   step-execute      → seams "column agent missing from registry at step-execute seam → fallback…"
//   restart watcher   → princ "column agent deleted mid-session → no restart storm…fallback (R8)"
//
// NO-BINDING (parity / invisibility) ──────────────────────────────────────────
//   execute seam      → seams characterization "execute seam: …assigned agent, no column-agent log"
//   step-execute      → seams characterization "step session: attribution falls back to assignedAgentId"
//   gating principal  → princ "no binding → gating context built for the assigned Y (byte-identical)"
//   default workflow  → workflow-graph-executor-parity.test.ts "column agent feature is invisible…"
//
// Cells deliberately NOT separately pinned: defer × heartbeat × own-absent at the
// *surface* level — the deferral gate's only column-agent input is the resolver
// verdict (proven in resolver) routed through resolveEffectivePrincipalId (proven
// override-side, where the principal differs from assignedAgentId; under defer ×
// own-absent the principal is still the column agent by the same code path).
// ─────────────────────────────────────────────────────────────────────────────
//
// The graph EXECUTE seam (single coding session) and STEP-EXECUTE seam
// (StepSessionExecutor per-step sessions) must run as the column agent when the
// governing seam node's DECLARED column carries a binding. Session identity =
// model + persona + attribution (gating/heartbeat/restart are U5, untouched here).
//
// Harness: mirrors executor-step-session.test.ts / executor-column-agent-custom-
// node.test.ts — a real TaskExecutor over a mock store with `createFnAgent`
// (the outermost session-spawn boundary) mocked, plus the entirely-mocked
// StepSessionExecutor from executor-test-helpers so the step-session branch's
// constructor options are observable.
//
// The two per-run seam slots the executor reads — `graphSeamGoverningNodeId` and
// `graphColumnAgentResolver` — are normally stamped by the graph seam wiring
// (createPromptLikeHandler → execute/stepExecute seams). We seed them directly and
// drive `runImplementationPhase` (the exact call the execute seam makes, which
// registers a completion interceptor so graph routing is skipped) so the session
// build runs the production resolution path with no scripted session layer.

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedStepSessionExecutor,
  mockExecuteAll,
  resetExecutorMocks,
} from "./executor-test-helpers.js";
import type { WorkflowColumnAgent } from "@fusion/core";

// The mocked resolveExecutorSessionModel (executor-test-helpers) reads
// `runtimeConfig.model` in "provider/modelId" form, so the column agent advertises
// its model that way; the assigned agent advertises a different one so we can prove
// which one reached the session.
function makeColumnAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-col",
    name: "Senior Reviewer",
    soul: "I am the senior reviewer.",
    instructionsText: "Always be thorough.",
    memory: undefined,
    runtimeConfig: { model: "anthropic/claude-col", runtimeHint: "col-hint" },
    ...overrides,
  };
}

function makeAssignedAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-Y",
    name: "Assigned Agent",
    soul: "I am the assigned agent.",
    instructionsText: "Assigned persona.",
    memory: undefined,
    runtimeConfig: { model: "openai/gpt-assigned", runtimeHint: "assigned-hint" },
    ...overrides,
  };
}

/** A mock fn agent that immediately calls fn_task_done so execute() completes. */
function installTaskDoneAgent() {
  mockedCreateFnAgent.mockImplementation((async (opts: any) => {
    const tools = opts.customTools || [];
    return {
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          const done = tools.find((t: any) => t.name === "fn_task_done");
          if (done) await done.execute("tool-1", {});
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    };
  }) as any);
}

function makeExecutor(store: ReturnType<typeof createMockStore>, agentsById: Record<string, unknown>) {
  const agentStore = {
    getAgent: vi.fn(async (id: string) => agentsById[id] ?? null),
  };
  const executor = new TaskExecutor(store as any, "/tmp/test", { agentStore } as any);
  return { executor, agentStore };
}

/**
 * Seed the per-run column-agent seam slots the executor reads at session-build
 * time, then drive the implementation phase the way the execute seam does.
 */
async function runExecuteSeam(
  executor: TaskExecutor,
  task: any,
  governingNodeId: string,
  binding: WorkflowColumnAgent | undefined,
) {
  (executor as any).graphSeamGoverningNodeId.set(task.id, governingNodeId);
  (executor as any).graphColumnAgentResolver.set(task.id, (nodeId: string) =>
    nodeId === governingNodeId ? binding : undefined,
  );
  return (executor as any).runImplementationPhase(task);
}

/** Force the step-session physics path and seed the seam slots, then run. */
async function runStepSessionSeam(
  executor: TaskExecutor,
  task: any,
  governingNodeId: string,
  binding: WorkflowColumnAgent | undefined,
) {
  (executor as any).graphStepSessionPinned.add(task.id);
  (executor as any).graphSeamGoverningNodeId.set(task.id, governingNodeId);
  (executor as any).graphColumnAgentResolver.set(task.id, (nodeId: string) =>
    nodeId === governingNodeId ? binding : undefined,
  );
  return (executor as any).runImplementationPhase(task);
}

function singleSessionTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-001",
    title: "Test",
    description: "Test task",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "in-progress" }],
    currentStep: 0,
    log: [],
    prompt: "# test\n## Steps\n### Step 0: Implement\n- [ ] implement",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function lastFnAgentOpts() {
  const calls = mockedCreateFnAgent.mock.calls;
  return calls[calls.length - 1]?.[0] as any;
}

function lastStepExecutorOpts() {
  const calls = mockedStepSessionExecutor.mock.calls;
  return calls[calls.length - 1]?.[0] as any;
}

function loggedLines(store: ReturnType<typeof createMockStore>): string[] {
  return store.logEntry.mock.calls.map((call: any[]) => String(call[1] ?? ""));
}

const OVERRIDE_COL: WorkflowColumnAgent = { agentId: "agent-col", mode: "override" };
const DEFER_COL: WorkflowColumnAgent = { agentId: "agent-col", mode: "defer" };

describe("column-agent coding seams (plan U4)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  // ── Characterization (pre-substitution behavior) ──────────────────────────
  // These pin the assignedAgentId-driven session identity that exists today and
  // MUST stay byte-identical on the no-binding path after substitution.

  describe("characterization: no binding → assignedAgentId session identity unchanged", () => {
    it("execute seam: session model/persona built from the assigned agent, no column-agent log", async () => {
      const store = createMockStore();
      const task = singleSessionTask({ assignedAgentId: "agent-Y" });
      store.getTask.mockResolvedValue(task as any);
      const { executor } = makeExecutor(store, { "agent-Y": makeAssignedAgent() });
      installTaskDoneAgent();

      // No governing node / no binding seeded → legacy path.
      await (executor as any).runImplementationPhase(task);

      const opts = lastFnAgentOpts();
      // Model resolved from the ASSIGNED agent's runtimeConfig.model.
      expect(opts.defaultProvider).toBe("openai");
      expect(opts.defaultModelId).toBe("gpt-assigned");
      // No column-agent adoption logged.
      expect(loggedLines(store).some((l) => l.includes("running as column agent"))).toBe(false);
    });

    it("step session: attribution falls back to assignedAgentId; no effectiveAgentId override", async () => {
      const store = createMockStore();
      const task = singleSessionTask({ assignedAgentId: "agent-Y" });
      store.getTask.mockResolvedValue(task as any);
      const { executor } = makeExecutor(store, { "agent-Y": makeAssignedAgent() });
      installTaskDoneAgent();

      (executor as any).graphStepSessionPinned.add(task.id);
      await (executor as any).runImplementationPhase(task);

      const opts = lastStepExecutorOpts();
      // No column agent governs → no attribution override (StepSessionExecutor
      // falls back to taskDetail.assignedAgentId ?? "executor").
      expect(opts.effectiveAgentId).toBeUndefined();
      // Model precedence input is the assigned agent's runtimeConfig.
      expect(opts.assignedAgentRuntimeConfig).toEqual(makeAssignedAgent().runtimeConfig);
      expect(loggedLines(store).some((l) => l.includes("running as column agent"))).toBe(false);
    });
  });

  // ── Execute seam (single coding session) ──────────────────────────────────

  describe("execute seam", () => {
    it("override column, task assigned to Y → session uses column agent X's model/persona/identity + audit", async () => {
      const store = createMockStore();
      const task = singleSessionTask({ assignedAgentId: "agent-Y" });
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, {
        "agent-Y": makeAssignedAgent(),
        "agent-col": makeColumnAgent(),
      });
      installTaskDoneAgent();

      await runExecuteSeam(executor, task, "execute-node", OVERRIDE_COL);

      const opts = lastFnAgentOpts();
      // Column agent X's model supersedes the assigned agent Y's.
      expect(opts.defaultProvider).toBe("anthropic");
      expect(opts.defaultModelId).toBe("claude-col");
      // Persona: column agent's soul + instructionsText reach the session system
      // prompt layers (KTD-6 typed fields).
      const promptText = JSON.stringify(opts.systemPromptLayers ?? "") + (opts.systemPrompt ?? "");
      expect(promptText).toContain("I am the senior reviewer.");
      expect(promptText).toContain("Always be thorough.");
      // The column agent was fetched (identity), not just the assigned agent.
      expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
      // Audit names the substitution + mode.
      expect(
        loggedLines(store).some(
          (l) => l.includes("running as column agent 'agent-col' (override)") && l.includes("execute-node"),
        ),
      ).toBe(true);
    });

    it("defer column, task with complete modelProvider/modelId → task settings win", async () => {
      const store = createMockStore();
      // Task carries a complete own model pair → defer must yield own settings.
      const task = singleSessionTask({ modelProvider: "task-prov", modelId: "task-model" });
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, { "agent-col": makeColumnAgent() });
      installTaskDoneAgent();

      await runExecuteSeam(executor, task, "execute-node", DEFER_COL);

      const opts = lastFnAgentOpts();
      // The task's own complete pair wins (mocked resolver: no agent runtimeConfig
      // model, falls through to the task pair).
      expect(opts.defaultProvider).toBe("task-prov");
      expect(opts.defaultModelId).toBe("task-model");
      // Column agent never fetched/adopted.
      expect(agentStore.getAgent).not.toHaveBeenCalledWith("agent-col");
      expect(loggedLines(store).some((l) => l.includes("running as column agent"))).toBe(false);
    });

    it("defer column, task with own assignedAgentId only (NO model pair) → own-settings win, column agent NOT adopted", async () => {
      // KTD-5 at the seam: an own agent IDENTITY alone counts as own-settings even
      // without a complete model pair, so a defer column must NOT adopt the column
      // agent. (Distinct from the bare-task case below where the column agent wins.)
      const store = createMockStore();
      const task = singleSessionTask({ assignedAgentId: "agent-Y" }); // no modelProvider/modelId
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, {
        "agent-Y": makeAssignedAgent(),
        "agent-col": makeColumnAgent(),
      });
      installTaskDoneAgent();

      await runExecuteSeam(executor, task, "execute-node", DEFER_COL);

      const opts = lastFnAgentOpts();
      // Fell back to the assigned agent's model — column agent's model not adopted.
      expect(opts.defaultProvider).toBe("openai");
      expect(opts.defaultModelId).toBe("gpt-assigned");
      // Column agent never fetched/adopted, no adoption audit.
      expect(agentStore.getAgent).not.toHaveBeenCalledWith("agent-col");
      expect(loggedLines(store).some((l) => l.includes("running as column agent"))).toBe(false);
    });

    it("defer column, bare task (no own settings) → column agent adopted", async () => {
      const store = createMockStore();
      const task = singleSessionTask(); // no assignedAgentId, no model pair
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, { "agent-col": makeColumnAgent() });
      installTaskDoneAgent();

      await runExecuteSeam(executor, task, "execute-node", DEFER_COL);

      const opts = lastFnAgentOpts();
      expect(opts.defaultProvider).toBe("anthropic");
      expect(opts.defaultModelId).toBe("claude-col");
      expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
      expect(
        loggedLines(store).some((l) => l.includes("running as column agent 'agent-col' (defer)")),
      ).toBe(true);
    });

    it("override column, bare task (no own settings) → column agent adopted", async () => {
      // override × own-absent at the execute seam: the column agent wins
      // regardless of own settings, and here there are none to begin with.
      const store = createMockStore();
      const task = singleSessionTask(); // no assignedAgentId, no model pair
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, { "agent-col": makeColumnAgent() });
      installTaskDoneAgent();

      await runExecuteSeam(executor, task, "execute-node", OVERRIDE_COL);

      const opts = lastFnAgentOpts();
      expect(opts.defaultProvider).toBe("anthropic");
      expect(opts.defaultModelId).toBe("claude-col");
      expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
      expect(
        loggedLines(store).some((l) => l.includes("running as column agent 'agent-col' (override)")),
      ).toBe(true);
    });

    it("column agent missing from registry at seam time → fallback to assignedAgentId path, logged, run proceeds", async () => {
      const store = createMockStore();
      const task = singleSessionTask({ assignedAgentId: "agent-Y" });
      store.getTask.mockResolvedValue(task as any);
      // Column agent absent from the registry; assigned agent present.
      const { executor } = makeExecutor(store, { "agent-Y": makeAssignedAgent() });
      installTaskDoneAgent();

      await runExecuteSeam(executor, task, "execute-node", OVERRIDE_COL);

      const opts = lastFnAgentOpts();
      // Fell back to the assigned agent's model.
      expect(opts.defaultProvider).toBe("openai");
      expect(opts.defaultModelId).toBe("gpt-assigned");
      // Fallback audited; no adoption claim.
      expect(
        loggedLines(store).some(
          (l) => l.includes("column agent 'agent-col' not found") && l.includes("falling back"),
        ),
      ).toBe(true);
      expect(loggedLines(store).some((l) => l.includes("running as column agent"))).toBe(false);
      // Run still proceeded: a session was built and the task done tool fired
      // (the missing column agent never aborted the session — R8).
      expect(mockedCreateFnAgent).toHaveBeenCalled();
    });

    it("integration: the column agent's executor model reaches createResolvedAgentSession options end-to-end", async () => {
      // Per the plugin-skills learning — prove with the REAL resolution layers
      // (only the outermost createFnAgent/session-spawn boundary is mocked).
      const store = createMockStore();
      const task = singleSessionTask({ assignedAgentId: "agent-Y" });
      store.getTask.mockResolvedValue(task as any);
      const { executor } = makeExecutor(store, {
        "agent-Y": makeAssignedAgent(),
        "agent-col": makeColumnAgent({ runtimeConfig: { model: "anthropic/claude-e2e", runtimeHint: "e2e-hint" } }),
      });
      installTaskDoneAgent();

      await runExecuteSeam(executor, task, "execute-node", OVERRIDE_COL);

      const opts = lastFnAgentOpts();
      expect(opts.defaultProvider).toBe("anthropic");
      expect(opts.defaultModelId).toBe("claude-e2e");
      // Runtime hint also follows the column agent end-to-end.
      expect(opts.runtimeHint).toBe("e2e-hint");
    });
  });

  // ── Step-execute seam (StepSessionExecutor per-step sessions) ─────────────

  describe("step-execute seam", () => {
    it("foreach instance node inherits the foreach's bound column → instance session carries column agent identity (attribution asserted)", async () => {
      const store = createMockStore();
      const task = singleSessionTask({ assignedAgentId: "agent-Y" });
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, {
        "agent-Y": makeAssignedAgent(),
        "agent-col": makeColumnAgent(),
      });
      installTaskDoneAgent();

      // Governing node is the foreach INSTANCE id; the resolver (which the real
      // core resolver implements via template inheritance) returns the foreach's
      // bound column binding for that instance id.
      const instanceNodeId = "foreach-1#0:step-exec";
      await runStepSessionSeam(executor, task, instanceNodeId, OVERRIDE_COL);

      const opts = lastStepExecutorOpts();
      // Attribution: the per-step session is attributed to the column agent.
      expect(opts.effectiveAgentId).toBe("agent-col");
      // Model precedence input is the column agent's runtimeConfig (not the
      // assigned agent's).
      expect(opts.assignedAgentRuntimeConfig).toEqual(makeColumnAgent().runtimeConfig);
      expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
      expect(mockExecuteAll).toHaveBeenCalled();
      expect(
        loggedLines(store).some((l) => l.includes("running as column agent 'agent-col' (override)")),
      ).toBe(true);
    });

    it("defer column with task own complete model pair → step session keeps assigned-agent attribution", async () => {
      const store = createMockStore();
      const task = singleSessionTask({
        assignedAgentId: "agent-Y",
        modelProvider: "task-prov",
        modelId: "task-model",
      });
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, {
        "agent-Y": makeAssignedAgent(),
        "agent-col": makeColumnAgent(),
      });
      installTaskDoneAgent();

      await runStepSessionSeam(executor, task, "foreach-1#0:step-exec", DEFER_COL);

      const opts = lastStepExecutorOpts();
      // Own settings (complete model pair) suppress the defer column agent.
      expect(opts.effectiveAgentId).toBeUndefined();
      expect(opts.assignedAgentRuntimeConfig).toEqual(makeAssignedAgent().runtimeConfig);
      expect(agentStore.getAgent).not.toHaveBeenCalledWith("agent-col");
    });

    it("override, bare task (no own settings) → step session carries column-agent attribution", async () => {
      // override × own-absent at the step-execute seam.
      const store = createMockStore();
      const task = singleSessionTask(); // no assignedAgentId, no model pair
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, { "agent-col": makeColumnAgent() });
      installTaskDoneAgent();

      await runStepSessionSeam(executor, task, "foreach-1#0:step-exec", OVERRIDE_COL);

      const opts = lastStepExecutorOpts();
      expect(opts.effectiveAgentId).toBe("agent-col");
      expect(opts.assignedAgentRuntimeConfig).toEqual(makeColumnAgent().runtimeConfig);
      expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
    });

    it("defer, bare task (no own settings) → step session adopts column-agent attribution", async () => {
      // defer × own-absent at the step-execute seam: nothing suppresses defer, so
      // the column agent is adopted.
      const store = createMockStore();
      const task = singleSessionTask(); // no assignedAgentId, no model pair
      store.getTask.mockResolvedValue(task as any);
      const { executor, agentStore } = makeExecutor(store, { "agent-col": makeColumnAgent() });
      installTaskDoneAgent();

      await runStepSessionSeam(executor, task, "foreach-1#0:step-exec", DEFER_COL);

      const opts = lastStepExecutorOpts();
      expect(opts.effectiveAgentId).toBe("agent-col");
      expect(opts.assignedAgentRuntimeConfig).toEqual(makeColumnAgent().runtimeConfig);
      expect(agentStore.getAgent).toHaveBeenCalledWith("agent-col");
      expect(
        loggedLines(store).some((l) => l.includes("running as column agent 'agent-col' (defer)")),
      ).toBe(true);
    });

    it("column agent missing from registry at step-execute seam → fallback to assigned-agent attribution, logged", async () => {
      const store = createMockStore();
      const task = singleSessionTask({ assignedAgentId: "agent-Y" });
      store.getTask.mockResolvedValue(task as any);
      const { executor } = makeExecutor(store, { "agent-Y": makeAssignedAgent() });
      installTaskDoneAgent();

      await runStepSessionSeam(executor, task, "foreach-1#0:step-exec", OVERRIDE_COL);

      const opts = lastStepExecutorOpts();
      expect(opts.effectiveAgentId).toBeUndefined();
      expect(opts.assignedAgentRuntimeConfig).toEqual(makeAssignedAgent().runtimeConfig);
      expect(
        loggedLines(store).some(
          (l) => l.includes("column agent 'agent-col' not found") && l.includes("falling back"),
        ),
      ).toBe(true);
    });
  });
});
