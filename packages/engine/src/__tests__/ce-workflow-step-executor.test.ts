/**
 * Compound-Engineering workflow-step skill-loading — executor integration
 * coverage. Drives the REAL TaskExecutor (over a mock store + mocked agent
 * session, the established executor harness) through:
 *
 *   - runGraphCustomNode (skill graph node) → asserts the synthesized
 *     WorkflowStep carries `skillName` and that the U2 conventions preamble is
 *     prepended to the prompt (item 3).
 *
 *   - executeWorkflowStep directly → asserts, by capturing the exact
 *     session-creation args reaching createFnAgent:
 *       * spawn gating: fn_spawn_agent present in coding, absent in readonly (item 4)
 *       * FUSION_HEADLESS: on stepEnv only when unattended=true (item 5)
 *       * the step's named skill is merged into requestedSkillNames as BOTH the
 *         namespaced and bare form, and FUSION_CE_SKILLS_DIR is threaded as
 *         additionalSkillPaths (item 2, integration half)
 *       * verdict conditional: gate / skill-less step gets the verdict-JSON
 *         Feedback Format; a non-gate skill step gets the relaxed Output Format (item 6)
 *
 * HARNESS NOTE: createFnAgent is mocked (executor-test-helpers) so no real model
 * runs. We assert on the arguments the executor hands the session layer — the
 * engine-owned wiring — not on model behavior. The mock session emits a verdict
 * line on prompt so the parse path completes cleanly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKFLOWS, type WorkflowIr } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  mockedExistsSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

type CapturedSession = {
  customTools?: Array<{ name?: string }>;
  systemPrompt?: string;
  taskEnv?: NodeJS.ProcessEnv;
  skillSelection?: { requestedSkillNames?: string[] };
  additionalSkillPaths?: string[];
};

/**
 * Make createFnAgent capture its session-creation args and return a mock session
 * that emits the given output line, then resolves. Returns the capture holder.
 */
function captureSession(output = '{"verdict":"APPROVE","notes":""}'): { last?: CapturedSession; all: CapturedSession[] } {
  const holder: { last?: CapturedSession; all: CapturedSession[] } = { all: [] };
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    const captured: CapturedSession = {
      customTools: opts.customTools,
      systemPrompt: opts.systemPrompt,
      taskEnv: opts.taskEnv,
      skillSelection: opts.skillSelection,
      additionalSkillPaths: opts.additionalSkillPaths,
    };
    holder.last = captured;
    holder.all.push(captured);

    const listeners: Array<(e: any) => void> = [];
    const session: any = {
      state: {},
      subscribe: (fn: (e: any) => void) => {
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

function makeExecutor(store: ReturnType<typeof createMockStore>) {
  const agentStore = { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() };
  const executor = new TaskExecutor(store as any, "/tmp/test", { agentStore } as any);
  return { executor, agentStore };
}

function baseStepTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-CE-1",
    title: "CE",
    description: "do the thing",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-ce-1",
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

function makeStep(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "graph:ce-plan",
    name: "Plan",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "advisory" as const,
    prompt: "Plan the work.",
    toolMode: "readonly" as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type CeSkillStep = {
  nodeId: string;
  name: string;
  skillName: string;
  bareSkillName: string;
  toolMode: "coding" | "readonly";
};

function compoundEngineeringSkillSteps(): CeSkillStep[] {
  const workflow = BUILTIN_WORKFLOWS.find((wf) => wf.id === "builtin:compound-engineering");
  if (!workflow) throw new Error("builtin:compound-engineering workflow not found");
  const nodes: any[] = [];
  const visit = (node: any) => {
    nodes.push(node);
    const templateNodes = node.config?.template?.nodes;
    if (Array.isArray(templateNodes)) {
      for (const child of templateNodes) visit(child);
    }
  };
  for (const node of workflow.ir.nodes as any[]) visit(node);
  return nodes
    .filter((node) => typeof node.config?.skillName === "string" && node.config.skillName.trim())
    .map((node: any) => {
      const skillName = node.config.skillName.trim();
      return {
        nodeId: node.id,
        name: typeof node.config.name === "string" && node.config.name.trim() ? node.config.name.trim() : node.id,
        skillName,
        bareSkillName: skillName.includes(":") ? skillName.slice(skillName.lastIndexOf(":") + 1) : skillName,
        toolMode: node.config.toolMode === "coding" ? "coding" : "readonly",
      };
    });
}

function skillLoadWarnings(store: ReturnType<typeof createMockStore>): string[] {
  return store.logEntry.mock.calls
    .map((call: unknown[]) => String(call[1] ?? ""))
    .filter((message: string) => message.includes("[skill-load]"));
}

/** captureModifiedFiles / git diff calls go through the mocked execSync→exec. */
function quietGit() {
  mockedExecSync.mockImplementation(() => Buffer.from(""));
}

describe("CE workflow-step executor integration", () => {
  beforeEach(() => {
    resetExecutorMocks();
    quietGit();
  });

  // ── Item 3: synthesized WorkflowStep from a skill graph node ────────────────
  describe("runGraphCustomNode skill node (U1/U2)", () => {
    it("carries skillName onto the synthesized step AND prepends the conventions preamble", async () => {
      const store = createMockStore();
      store.getTask.mockResolvedValue(baseStepTask() as any);
      const { executor } = makeExecutor(store);

      const captured: { step?: any } = {};
      vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
        captured.step = args[1];
        return { success: true, output: "ok" };
      });

      const node = {
        id: "ce-plan",
        kind: "prompt",
        column: "review",
        config: { executor: "skill", skillName: "compound-engineering:ce-plan", prompt: "Plan the work." },
      };

      const result = await (executor as any).runGraphCustomNode(node, { id: "FN-CE-1" }, {}, undefined);

      expect(result.outcome).toBe("success");
      // (U1) skillName threaded onto the step so the session can LOAD it.
      expect(captured.step.skillName).toBe("compound-engineering:ce-plan");
      // (U2) conventions preamble prepended before the "Invoke the skill" line.
      expect(captured.step.prompt).toContain("## Fusion workflow-step conventions");
      expect(captured.step.prompt).toContain("===FUSION_AWAIT_INPUT===");
      expect(captured.step.prompt).toContain('Invoke the "compound-engineering:ce-plan" skill');
      // Original node prompt still present after the preamble.
      expect(captured.step.prompt).toContain("Plan the work.");
    });

    it("lets the graph prepare a task worktree before the first CE coding-mode node runs", async () => {
      const store = createMockStore();
      let live = baseStepTask({
        worktree: undefined,
        branch: undefined,
        steps: [{ name: "Preflight", status: "pending" }],
      });
      store.getTask.mockImplementation(async () => live as any);
      store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        live = { ...live, ...patch };
        return live as any;
      });
      const { executor } = makeExecutor(store);
      vi.spyOn(executor as any, "createWorktree").mockResolvedValue({
        path: "/tmp/test/.worktrees/swift-falcon",
        branch: "fusion/fn-ce-1",
      });
      vi.spyOn(executor as any, "captureBaseCommitSha").mockResolvedValue(undefined);

      const captured: { step?: any; worktreePath?: string } = {};
      vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
        captured.step = args[1];
        captured.worktreePath = args[2];
        return { success: true, output: "ok" };
      });

      const node = {
        id: "plan",
        kind: "prompt",
        column: "in-progress",
        config: {
          executor: "skill",
          skillName: "compound-engineering:ce-plan",
          toolMode: "coding",
          prompt: "Run /ce-plan.",
        },
      };

      const ir: WorkflowIr = {
        version: "v2",
        name: "ce-plan-test",
        columns: [{ id: "in-progress", name: "In Progress", traits: [] }],
        nodes: [
          { id: "start", kind: "start" },
          node as any,
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "plan" },
          { from: "plan", to: "end", condition: "success" },
        ],
      };
      const settings = await store.getSettings();
      const graph = new WorkflowGraphExecutor({
        prepareNodeExecution: (graphNode, task, requirement) =>
          (executor as any).prepareGraphNodeExecution(graphNode, task, settings, requirement),
        runCustomNode: (graphNode, task, context) =>
          (executor as any).runGraphCustomNode(graphNode, task, settings, undefined, context),
      });

      const result = await graph.run(live as any, settings, ir);

      expect(result.outcome).toBe("success");
      expect((executor as any).createWorktree).toHaveBeenCalled();
      expect(captured.worktreePath).toBe("/tmp/test/.worktrees/swift-falcon");
      expect(captured.step.toolMode).toBe("coding");
      expect(live.worktree).toBe("/tmp/test/.worktrees/swift-falcon");
    });

    it("reacquires a task worktree when a CE graph node finds a stale missing checkout", async () => {
      const store = createMockStore();
      mockedExistsSync.mockImplementation((path) => path !== "/tmp/test/.worktrees/missing-ce-checkout");
      let live = baseStepTask({
        worktree: "/tmp/test/.worktrees/missing-ce-checkout",
        branch: "fusion/fn-ce-1",
        steps: [{ name: "Preflight", status: "pending" }],
      });
      store.getTask.mockImplementation(async () => live as any);
      store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        live = { ...live, ...patch };
        return live as any;
      });
      const { executor } = makeExecutor(store);
      vi.spyOn(executor as any, "createWorktree").mockResolvedValue({
        path: "/tmp/test/.worktrees/fresh-ce-checkout",
        branch: "fusion/fn-ce-1",
      });
      vi.spyOn(executor as any, "captureBaseCommitSha").mockResolvedValue(undefined);

      const captured: { worktreePath?: string } = {};
      vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
        captured.worktreePath = args[2];
        return { success: true, output: "ok" };
      });

      const node = {
        id: "plan",
        kind: "prompt",
        column: "in-progress",
        config: {
          executor: "skill",
          skillName: "compound-engineering:ce-plan",
          toolMode: "coding",
          prompt: "Run /ce-plan.",
        },
      };
      const ir: WorkflowIr = {
        version: "v2",
        name: "ce-plan-stale-worktree-test",
        columns: [{ id: "in-progress", name: "In Progress", traits: [] }],
        nodes: [
          { id: "start", kind: "start" },
          node as any,
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "plan" },
          { from: "plan", to: "end", condition: "success" },
        ],
      };
      const settings = await store.getSettings();
      const graph = new WorkflowGraphExecutor({
        prepareNodeExecution: (graphNode, task, requirement) =>
          (executor as any).prepareGraphNodeExecution(graphNode, task, settings, requirement),
        runCustomNode: (graphNode, task, context) =>
          (executor as any).runGraphCustomNode(graphNode, task, settings, undefined, context),
      });

      const result = await graph.run(live as any, settings, ir);

      expect(result.outcome).toBe("success");
      expect((executor as any).createWorktree).toHaveBeenCalled();
      expect(captured.worktreePath).toBe("/tmp/test/.worktrees/fresh-ce-checkout");
      expect(live.worktree).toBe("/tmp/test/.worktrees/fresh-ce-checkout");
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-CE-1",
        "Workflow node 'plan' assigned worktree is missing — reacquiring before node execution",
        "/tmp/test/.worktrees/missing-ce-checkout",
        undefined,
      );
    });

    it.each([
      ["acquires an absent worktree", undefined, "/tmp/test/.worktrees/acquired-code-review", 1],
      ["reuses a live worktree", "/tmp/test/.worktrees/live-code-review", "/tmp/test/.worktrees/live-code-review", 0],
      ["reacquires a stale worktree", "/tmp/test/.worktrees/stale-code-review", "/tmp/test/.worktrees/acquired-code-review", 1],
    ])("prepares an inline-fix Code Review node when it %s", async (_scenario, existingWorktree, expectedWorktree, acquisitionCount) => {
      mockedExistsSync.mockImplementation((path) => path !== "/tmp/test/.worktrees/stale-code-review");
      const store = createMockStore();
      let live = baseStepTask({
        worktree: existingWorktree,
        branch: existingWorktree ? "fusion/fn-ce-1" : undefined,
        enabledWorkflowSteps: ["code-review"],
      });
      store.getTask.mockImplementation(async () => live as any);
      store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        live = { ...live, ...patch };
        return live as any;
      });
      const { executor } = makeExecutor(store);
      vi.spyOn(executor as any, "createWorktree").mockResolvedValue({
        path: "/tmp/test/.worktrees/acquired-code-review",
        branch: "fusion/fn-ce-1",
      });
      vi.spyOn(executor as any, "captureBaseCommitSha").mockResolvedValue(undefined);
      const executeStep = vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "APPROVE" });
      const requirements: any[] = [];
      const codeReview = {
        id: "code-review-step",
        kind: "gate",
        config: { name: "Code Review", prompt: "Review the implementation." },
      };
      const ir: WorkflowIr = {
        version: "v2",
        name: "code-review-worktree-test",
        columns: [{ id: "in-progress", name: "In Progress", traits: [] }],
        nodes: [
          { id: "start", kind: "start" },
          {
            id: "code-review",
            kind: "optional-group",
            config: { name: "Code Review", defaultOn: true, template: { nodes: [codeReview], edges: [] } },
          },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "code-review" },
          { from: "code-review", to: "end", condition: "success" },
        ],
      };
      const settings = { ...(await store.getSettings()), reviewerInlineFixes: true };
      const graph = new WorkflowGraphExecutor({
        prepareNodeExecution: (graphNode, task, requirement) => {
          requirements.push(requirement);
          return (executor as any).prepareGraphNodeExecution(graphNode, task, settings, requirement);
        },
        runCustomNode: (graphNode, task, context) =>
          (executor as any).runGraphCustomNode(graphNode, task, settings, undefined, context),
      });

      const result = await graph.run(live as any, settings, ir);

      expect(requirements).toContainEqual({ requiresWorktree: true, reason: "write-capable-node" });
      expect((executor as any).createWorktree).toHaveBeenCalledTimes(acquisitionCount);
      expect(executeStep).toHaveBeenCalledTimes(1);
      expect(executeStep.mock.calls[0]?.[2]).toBe(expectedWorktree);
      expect(result).toMatchObject({ outcome: "success" });
      expect(result.context["node:code-review:outcome"]).not.toBe("no-worktree-for-write-node");
    });

    it("keeps disabled inline fixes and Plan Review read-only during graph preparation", async () => {
      const requirements: any[] = [];
      const graph = new WorkflowGraphExecutor({
        prepareNodeExecution: (_node, _task, requirement) => { requirements.push(requirement); },
        handlers: { gate: async () => ({ outcome: "success" }) },
      });
      const optionalGroup = (id: string, name: string) => ({
        id,
        kind: "optional-group" as const,
        config: { name, defaultOn: true, template: { nodes: [{ id: `${id}-step`, kind: "gate" as const, config: { name } }], edges: [] } },
      });
      const ir: WorkflowIr = {
        version: "v2",
        name: "readonly-review-worktree-test",
        columns: [],
        nodes: [{ id: "start", kind: "start" }, optionalGroup("code-review", "Code Review"), optionalGroup("plan-review", "Plan Review"), { id: "end", kind: "end" }],
        edges: [
          { from: "start", to: "code-review" },
          { from: "code-review", to: "plan-review", condition: "success" },
          { from: "plan-review", to: "end", condition: "success" },
        ],
      };
      await graph.run(baseStepTask({ enabledWorkflowSteps: ["code-review", "plan-review"] }) as any, {
        experimentalFeatures: {},
        reviewerInlineFixes: false,
      }, ir);
      expect(requirements).toEqual([]);
    });

    it("finalizes a merge-confirmed workflow graph task that is stranded before done", async () => {
      const store = createMockStore();
      let live = baseStepTask({
        column: "in-progress",
        status: null,
        error: null,
        mergeDetails: { mergeConfirmed: true, commitSha: "abc123" },
        steps: [{ name: "Preflight", status: "done" }],
      });
      store.getTask.mockImplementation(async () => live as any);
      store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        live = { ...live, ...patch };
        return live as any;
      });
      store.moveTask.mockImplementation(async (_id: string, column: string) => {
        live = { ...live, column };
        return live as any;
      });
      const { executor } = makeExecutor(store);

      const handled = await (executor as any).finalizeMergeConfirmedWorkflowGraphTask("FN-CE-1", "test");

      expect(handled).toBe(true);
      expect(store.moveTask).toHaveBeenCalledWith("FN-CE-1", "done", expect.objectContaining({
        recoveryRehome: true,
        preserveProgress: true,
      }));
      expect(live.column).toBe("done");
      expect(live.mergeDetails?.mergeConfirmed).toBe(true);
    });

    it("lets stale no-op merge proof fall through when implementation steps are incomplete", async () => {
      const store = createMockStore();
      const live = baseStepTask({
        column: "in-progress",
        status: "failed",
        error: "Merge confirmed but finalization blocked: task has incomplete steps",
        mergeDetails: { mergeConfirmed: true, noOpMerge: true, noOpReason: "already-merged" },
        steps: [
          { name: "Preflight", status: "in-progress" },
          { name: "Implement", status: "pending" },
        ],
      });
      store.getTask.mockResolvedValue(live as any);
      const { executor } = makeExecutor(store);

      /*
       * FNXC:WorkflowMerge 2026-06-29-23:12:
       * A no-op merge confirmation without a landed commit is not implementation proof. When reopened work still has incomplete legacy steps, execute() must continue to stale-merge cleanup/reverification instead of consuming the run in merge-confirmed finalization.
       */
      const handled = await (executor as any).finalizeMergeConfirmedWorkflowGraphTask("FN-CE-1", "test");

      expect(handled).toBe(false);
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-CE-1", "done", expect.anything());
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-CE-1",
        expect.stringContaining("merge-confirmed finalization blocked"),
        undefined,
        undefined,
      );
    });

    it("blocks the merge requester when graph traversal reaches merge before implementation steps finish", async () => {
      const store = createMockStore();
      let live = baseStepTask({
        column: "in-progress",
        status: null,
        error: null,
        steps: [
          { name: "Preflight", status: "in-progress" },
          { name: "Implement", status: "pending" },
        ],
      });
      store.getTask.mockImplementation(async () => live as any);
      store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        live = { ...live, ...patch };
        return live as any;
      });
      store.moveTask.mockImplementation(async (_id: string, column: string) => {
        live = { ...live, column };
        return live as any;
      });
      const { executor } = makeExecutor(store);
      const mergeRequester = vi.fn(async () => ({ ok: true, merged: false, noOp: true, mergeConfirmed: true }));
      executor.setMergeRequester(mergeRequester as any);
      const settings = await store.getSettings();
      const primitives = (executor as any).createAuthoritativeWorkflowPrimitives(settings);

      /*
       * FNXC:WorkflowMerge 2026-06-29-23:18:
       * Reaching the merge node is not itself proof that implementation ran. The requester must not create a no-op merge for an unfinished legacy checklist; the graph failure path will route the task back to executable work.
       */
      const result = await primitives.requestMerge(
        {
          run: { runId: "run-1", taskId: "FN-CE-1", workflowId: "builtin:coding" },
          node: { node: { id: "merge", kind: "prompt", column: "in-review", config: { seam: "merge" } }, context: {} },
        },
        live,
      );

      expect(result).toEqual(expect.objectContaining({
        outcome: "failure",
        value: "implementation-incomplete",
      }));
      expect(mergeRequester).not.toHaveBeenCalled();
      // FNXC:WorkflowMerge 2026-07-07-08:38: The merge boundary (executor.ts:6305, 6fc50d8d9e) now moves the task to in-review and logs the boundary move BEFORE the implementation-proof gate runs, then the proof failure is logged separately. The proof-failure text (executor.ts:6345) changed from the static "implementation steps are incomplete" to the parse-step-aware "implementation did not run: parsed coding steps are missing or incomplete". Assert both log entries so the new two-stage merge-boundary behavior is pinned.
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-CE-1",
        "Workflow merge boundary moved task to in-review before requesting merge",
        undefined,
        undefined,
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-CE-1",
        "Workflow merge blocked before requester: implementation did not run: parsed coding steps are missing or incomplete",
        undefined,
        undefined,
      );
    });

    it("uses moveTask for workflow graph column transitions so lifecycle notifications fire", async () => {
      const store = createMockStore();
      store.getTask.mockResolvedValue(baseStepTask({ column: "todo" }) as any);
      const { executor } = makeExecutor(store);
      const settings = await store.getSettings();
      const primitives = (executor as any).createAuthoritativeWorkflowPrimitives(settings);

      const result = await primitives.transitionTask(
        {
          run: { runId: "run-1", taskId: "FN-CE-1", workflowId: "builtin:coding" },
          node: { node: { id: "schedule", kind: "prompt", column: "todo", config: {} }, context: {} },
        },
        baseStepTask({ column: "todo" }),
        {
          column: "in-progress",
          status: "queued",
          reason: "workflow-schedule",
          preserveProgress: true,
        },
      );

      expect(result).toEqual({ outcome: "success", value: "workflow-schedule" });
      expect(store.moveTask).toHaveBeenCalledWith(
        "FN-CE-1",
        "in-progress",
        expect.objectContaining({
          moveSource: "engine",
          preserveProgress: true,
          workflowMoveSource: "workflow-graph",
          workflowMoveMetadata: expect.objectContaining({
            reason: "workflow-schedule",
            nodeId: "schedule",
            workflowId: "builtin:coding",
            runId: "run-1",
          }),
        }),
      );
      expect(store.updateTask).toHaveBeenCalledWith("FN-CE-1", { status: "queued" });
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-CE-1", expect.objectContaining({ column: "in-progress" }));
    });

    it("moves direct-to-merge workflow tasks into in-review before requesting merge", async () => {
      const store = createMockStore();
      let live = baseStepTask({
        column: "in-progress",
        steps: [{ name: "Implement", status: "done" }],
      });
      store.getTask.mockImplementation(async () => live as any);
      store.moveTask.mockImplementation(async (_id: string, column: string) => {
        live = { ...live, column };
        return live as any;
      });
      const { executor } = makeExecutor(store);
      const mergeRequester = vi.fn(async () => ({
        task: live,
        branch: "fusion/fn-ce-1",
        merged: false,
        noOp: false,
        reason: "queued",
      }));
      executor.setMergeRequester(mergeRequester as any);
      const settings = await store.getSettings();
      const primitives = (executor as any).createAuthoritativeWorkflowPrimitives(settings);

      const result = await primitives.requestMerge(
        {
          run: { runId: "run-merge", taskId: "FN-CE-1", workflowId: "builtin:quick-fix" },
          node: { node: { id: "merge", kind: "prompt", column: "in-review", config: { seam: "merge" } }, context: {} },
        },
        live,
      );

      expect(result).toEqual({
        outcome: "failure",
        value: "queued",
        data: { status: "failed", reason: "queued" },
      });
      expect(store.moveTask).toHaveBeenCalledWith(
        "FN-CE-1",
        "in-review",
        expect.objectContaining({
          preserveProgress: true,
          moveSource: "engine",
          workflowMoveSource: "workflow-graph",
          workflowMoveMetadata: expect.objectContaining({
            reason: "workflow-merge-boundary",
            nodeId: "merge",
            workflowId: "builtin:quick-fix",
            runId: "run-merge",
          }),
        }),
      );
      expect(mergeRequester).toHaveBeenCalledWith("FN-CE-1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(live.column).toBe("in-review");
    });

    it("completes graph-native checklist projection before a workflow merge request", async () => {
      const store = createMockStore();
      let live = baseStepTask({
        column: "in-progress",
        steps: [
          { name: "Diagnose", status: "pending" },
          { name: "Implement", status: "pending" },
        ],
        workflowStepResults: [
          {
            workflowStepId: "plan",
            workflowStepName: "Plan",
            phase: "pre-merge",
            source: "node",
            status: "passed",
          },
        ],
      });
      store.getTask.mockImplementation(async () => live as any);
      store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        live = { ...live, ...patch };
        return live as any;
      });
      store.moveTask.mockImplementation(async (_id: string, column: string) => {
        live = { ...live, column };
        return live as any;
      });
      const { executor } = makeExecutor(store);
      const mergeRequester = vi.fn(async () => ({
        task: live,
        branch: "fusion/fn-ce-1",
        merged: false,
        noOp: false,
        reason: "queued",
      }));
      executor.setMergeRequester(mergeRequester as any);
      const settings = await store.getSettings();
      const primitives = (executor as any).createAuthoritativeWorkflowPrimitives(settings);

      await primitives.requestMerge(
        {
          run: { runId: "run-merge", taskId: "FN-CE-1", workflowId: "builtin:compound-engineering" },
          node: { node: { id: "merge", kind: "prompt", column: "in-review", config: { seam: "merge" } }, context: {} },
        },
        live,
      );

      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-CE-1",
        expect.objectContaining({
          steps: [
            { name: "Diagnose", status: "done" },
            { name: "Implement", status: "done" },
          ],
          currentStep: 1,
        }),
        undefined,
      );
      expect(mergeRequester).toHaveBeenCalledWith("FN-CE-1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(live.steps.every((step: any) => step.status === "done")).toBe(true);
      expect(live.column).toBe("in-review");
    });

    it("skips manual PR optional groups while effective auto-merge is on", async () => {
      const store = createMockStore();
      const live = baseStepTask({
        autoMerge: true,
        enabledWorkflowSteps: ["manual-pr-review"],
      });
      store.getTask.mockResolvedValue(live as any);
      const { executor } = makeExecutor(store);
      const runCustomNode = vi.spyOn(executor as any, "runGraphCustomNode").mockResolvedValue({ outcome: "success", value: "ran" });
      const graph = new WorkflowGraphExecutor({
        runCustomNode: (graphNode, task, context) =>
          (executor as any).runGraphCustomNode(graphNode, task, {}, undefined, context),
      });
      const ir: WorkflowIr = {
        version: "v2",
        name: "manual-pr-automerge-skip",
        columns: [{ id: "in-review", name: "In Review", traits: [] }],
        nodes: [
          { id: "start", kind: "start" },
          {
            id: "manual-pr-review",
            kind: "optional-group",
            column: "in-review",
            config: {
              defaultOn: false,
              requiresAutoMergeOff: true,
              template: {
                nodes: [{ id: "commit", kind: "prompt", config: { prompt: "commit" } }],
                edges: [],
              },
            },
          },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "manual-pr-review" },
          { from: "manual-pr-review", to: "end", condition: "success" },
        ],
      };

      const result = await graph.run(live as any, { experimentalFeatures: {}, autoMerge: true }, ir);

      expect(result.outcome).toBe("success");
      expect(runCustomNode).not.toHaveBeenCalled();
    });

    it("clears stale workflow input markers when a resumed graph restarts before the original node", async () => {
      const store = createMockStore();
      let live = baseStepTask({
        paused: false,
        status: null,
        pausedReason: "workflow-input:commit-pr@1782751605619: Should I rewrite the PR?",
        steeringComments: [{ text: "Yes", createdAt: "2026-06-29T16:47:05.075Z" }],
      });
      store.getTask.mockImplementation(async () => live as any);
      store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
        live = { ...live, ...patch };
        return live as any;
      });
      const { executor } = makeExecutor(store);
      vi.spyOn(executor as any, "executeWorkflowStep").mockResolvedValue({ success: true, output: "ok" });

      const result = await (executor as any).runGraphCustomNode(
        {
          id: "plan",
          kind: "prompt",
          column: "in-progress",
          config: { executor: "skill", skillName: "compound-engineering:ce-plan", prompt: "Plan the work." },
        },
        live,
        {},
        undefined,
      );

      expect(result.outcome).toBe("success");
      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-CE-1",
        { status: null, pausedReason: null },
        undefined,
      );
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-CE-1",
        "Workflow input marker 'commit-pr' already has a reply — clearing stale marker before step 'plan'",
        undefined,
        undefined,
      );
      expect(live.pausedReason).toBeNull();
    });

    it("treats terminal graph step projection as success when the legacy pass rejects", async () => {
      const store = createMockStore();
      store.getTask.mockResolvedValue(baseStepTask({
        steps: [{ name: "Preflight", status: "done" }],
      }) as any);
      const { executor } = makeExecutor(store);
      vi.spyOn(executor as any, "runImplementationPhase").mockRejectedValue(new Error("Agent finished without calling fn_task_done"));

      const result = await (executor as any).runGraphTaskStep(baseStepTask(), 0, "steps#0", "steps#0:step-execute");

      expect(result).toEqual({ success: true });
    });

    it("a non-skill (model) node synthesizes NO skillName and NO preamble", async () => {
      const store = createMockStore();
      store.getTask.mockResolvedValue(baseStepTask() as any);
      const { executor } = makeExecutor(store);

      const captured: { step?: any } = {};
      vi.spyOn(executor as any, "executeWorkflowStep").mockImplementation(async (...args: any[]) => {
        captured.step = args[1];
        return { success: true, output: "ok" };
      });

      const node = { id: "review", kind: "prompt", column: "review", config: { prompt: "Just review." } };
      await (executor as any).runGraphCustomNode(node, { id: "FN-CE-1" }, {}, undefined);

      expect(captured.step.skillName).toBeUndefined();
      expect(captured.step.prompt).not.toContain("## Fusion workflow-step conventions");
      expect(captured.step.prompt).toContain("Just review.");
    });
  });

  // ── Item 5: FUSION_HEADLESS gating on stepEnv ───────────────────────────────
  describe("executeWorkflowStep FUSION_HEADLESS (U3)", () => {
    it.each([
      ["code-review group", { id: "custom-check", name: "Implementation Check", optionalGroupId: "code-review" }],
      ["browser-verification group", { id: "custom-check", name: "Implementation Check", optionalGroupId: "browser-verification" }],
      ["review name", { id: "custom-check", name: "Custom Review" }],
      ["verification name", { id: "custom-check", name: "Custom Verification" }],
      ["inline-fix metadata", { id: "custom-check", name: "Implementation Check", reviewCanFixInline: true }],
    ])("makes the approved PROMPT.md contract authoritative for the %s classifier", async (_label, classifier) => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();
      vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue(`
# Approved contract

Ship FIVE kinds. Do NOT add roadmap-item in this task.
      `.trim());

      await (executor as any).executeWorkflowStep(
        baseStepTask({ description: "Original request: ship SIX kinds including roadmap-item." }),
        makeStep({
          ...classifier,
          prompt: "Review the implementation against the approved task contract.",
          gateMode: "gate",
        }),
        "/tmp/wt",
        {},
      );

      expect(cap.last?.systemPrompt).toContain("--- BEGIN APPROVED PROMPT.md ---");
      expect(cap.last?.systemPrompt).toContain("Ship FIVE kinds. Do NOT add roadmap-item in this task.");
      expect(cap.last?.systemPrompt).toContain("PROMPT.md is the authoritative current contract");
      expect(cap.last?.systemPrompt).toContain("Do not enforce superseded requirements from the original Task Description");
    });

    it("does not restore the historical task description when PROMPT.md is unavailable", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();
      vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue(undefined);

      await (executor as any).executeWorkflowStep(
        baseStepTask({ description: "Original request: ship SIX kinds including roadmap-item." }),
        makeStep({ name: "Code Review", optionalGroupId: "code-review", gateMode: "gate" }),
        "/tmp/wt",
        {},
      );

      expect(cap.last?.systemPrompt).toContain("Approved Task Contract Unavailable");
      expect(cap.last?.systemPrompt).toContain("Task Description is historical input only and is not a substitute contract");
      expect(cap.last?.systemPrompt).toContain("Return REVISE with the single reason that the approved contract could not be loaded");
    });

    it("sets FUSION_HEADLESS=1 only when unattended=true; always sets FUSION_WORKFLOW_STEP", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      // unattended → headless present.
      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-plan" }),
        "/tmp/wt",
        {},
        undefined,
        { unattended: true },
      );
      expect(cap.last?.taskEnv?.FUSION_HEADLESS).toBe("1");
      expect(cap.last?.taskEnv?.FUSION_WORKFLOW_STEP).toBe("1");

      // board run (default / explicit false) → headless absent, workflow-step still set.
      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-plan" }),
        "/tmp/wt",
        {},
        undefined,
        { unattended: false },
      );
      expect(cap.last?.taskEnv?.FUSION_HEADLESS).toBeUndefined();
      expect(cap.last?.taskEnv?.FUSION_WORKFLOW_STEP).toBe("1");

      // no stepOptions at all → headless absent.
      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-plan" }),
        "/tmp/wt",
        {},
        undefined,
      );
      expect(cap.last?.taskEnv?.FUSION_HEADLESS).toBeUndefined();
    });

    it("strips an INHERITED FUSION_HEADLESS on a board run (default-safe invariant)", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      // An outer pipeline exported FUSION_HEADLESS=1 into the inherited env. A board
      // run (unattended=false) must NOT inherit it — otherwise the step silently
      // skips user questions instead of parking. (PR #1696 review fix.)
      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-plan" }),
        "/tmp/wt",
        {},
        { FUSION_HEADLESS: "1" },
        { unattended: false },
      );
      expect(cap.last?.taskEnv?.FUSION_HEADLESS).toBeUndefined();

      // An explicit unattended opt-in still sets it.
      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-plan" }),
        "/tmp/wt",
        {},
        { FUSION_HEADLESS: "1" },
        { unattended: true },
      );
      expect(cap.last?.taskEnv?.FUSION_HEADLESS).toBe("1");
    });
  });

  // ── Item 2 (integration half): skillName → requestedSkillNames + paths ───────
  describe("executeWorkflowStep skill merge (U1)", () => {
    const ceSkillSteps = compoundEngineeringSkillSteps();

    it("derives every skill-bearing step from the built-in compound-engineering workflow", () => {
      expect(ceSkillSteps.map((step) => step.skillName)).toEqual([
        "compound-engineering:ce-plan",
        "compound-engineering:ce-doc-review",
        "compound-engineering:ce-work",
        "compound-engineering:ce-code-review",
        "compound-engineering:ce-commit",
        "compound-engineering:ce-compound",
      ]);
    });

    it.each(ceSkillSteps)(
      "loads named skill for built-in CE step $nodeId ($skillName)",
      async ({ name, skillName, bareSkillName, toolMode }) => {
        const store = createMockStore();
        const { executor } = makeExecutor(store);
        const cap = captureSession();
        const ceSkillsDir = `/opt/ce/.fusion-ce-skills/${bareSkillName}`;

        await (executor as any).executeWorkflowStep(
          baseStepTask(),
          makeStep({ name, skillName, toolMode }),
          "/tmp/wt",
          {},
          { FUSION_CE_SKILLS_DIR: ceSkillsDir },
          undefined,
        );

        const requested = cap.last?.skillSelection?.requestedSkillNames ?? [];
        expect(requested).toContain(skillName);
        expect(requested).toContain(bareSkillName);
        // The install root from the injected env becomes the discovery path for every CE skill step.
        expect(cap.last?.additionalSkillPaths).toEqual([ceSkillsDir]);
        expect(skillLoadWarnings(store)).toEqual([]);
      },
    );

    it("warns loudly and does not set additionalSkillPaths when a skill step lacks FUSION_CE_SKILLS_DIR", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ name: "Execute", skillName: "compound-engineering:ce-work", toolMode: "coding" }),
        "/tmp/wt",
        {},
        undefined,
        undefined,
      );

      const requested = cap.last?.skillSelection?.requestedSkillNames ?? [];
      expect(requested).toContain("compound-engineering:ce-work");
      expect(requested).toContain("ce-work");
      expect(cap.last?.additionalSkillPaths).toBeUndefined();
      expect(skillLoadWarnings(store)).toEqual([
        "[skill-load] Workflow step 'Execute' requests skill 'compound-engineering:ce-work' but FUSION_CE_SKILLS_DIR is unset — the skill cannot be discovered; the step runs with role-fallback skills only.",
      ]);
    });

    it("a skill-less step contributes no skillName merge, no additionalSkillPaths, and no skill-load warning", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ gateMode: "gate" }), // no skillName
        "/tmp/wt",
        {},
        undefined,
        undefined,
      );

      const requested = cap.last?.skillSelection?.requestedSkillNames ?? [];
      expect(requested.some((name) => name.startsWith("compound-engineering:") || name.startsWith("ce-"))).toBe(false);
      // No CE skills dir injected → no additionalSkillPaths.
      expect(cap.last?.additionalSkillPaths).toBeUndefined();
      expect(skillLoadWarnings(store)).toEqual([]);
    });

    it.each(["coding", "readonly"] as const)(
      "keeps skill loading independent of %s toolMode",
      async (toolMode) => {
        const store = createMockStore();
        const { executor } = makeExecutor(store);
        const cap = captureSession();

        await (executor as any).executeWorkflowStep(
          baseStepTask(),
          makeStep({ skillName: "compound-engineering:ce-code-review", toolMode }),
          "/tmp/wt",
          {},
          { FUSION_CE_SKILLS_DIR: "/opt/ce/.fusion-ce-skills" },
          undefined,
        );

        const requested = cap.last?.skillSelection?.requestedSkillNames ?? [];
        expect(requested).toContain("compound-engineering:ce-code-review");
        expect(requested).toContain("ce-code-review");
        expect(cap.last?.additionalSkillPaths).toEqual(["/opt/ce/.fusion-ce-skills"]);
        expect(skillLoadWarnings(store)).toEqual([]);
      },
    );
  });

  // ── Item 4: spawn-tool gating by toolMode ───────────────────────────────────
  describe("executeWorkflowStep spawn gating (U8b)", () => {
    function toolNames(cap: ReturnType<typeof captureSession>): string[] {
      return (cap.last?.customTools ?? []).map((t) => t.name ?? "");
    }

    it("coding-mode step registers fn_spawn_agent", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-code-review", toolMode: "coding" }),
        "/tmp/wt",
        {},
        undefined,
        undefined,
      );

      expect(toolNames(cap)).toContain("fn_spawn_agent");
    });

    it("readonly-mode step does NOT register fn_spawn_agent", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-code-review", toolMode: "readonly" }),
        "/tmp/wt",
        {},
        undefined,
        undefined,
      );

      expect(toolNames(cap)).not.toContain("fn_spawn_agent");
    });
  });

  // ── Item 6: verdict-contract conditional ────────────────────────────────────
  describe("executeWorkflowStep verdict conditional (KTD-6)", () => {
    it("a GATE skill step still requires the trailing verdict JSON (Feedback Format)", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-code-review", gateMode: "gate" }),
        "/tmp/wt",
        {},
        undefined,
        undefined,
      );

      expect(cap.last?.systemPrompt).toContain("## Feedback Format");
      expect(cap.last?.systemPrompt).toContain('{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE"');
      expect(cap.last?.systemPrompt).not.toContain("## Output Format");
    });

    it("a skill-LESS prompt step requires the verdict JSON (legacy reviewer contract)", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ gateMode: "advisory" }), // no skillName, advisory
        "/tmp/wt",
        {},
        undefined,
        undefined,
      );

      expect(cap.last?.systemPrompt).toContain("## Feedback Format");
      expect(cap.last?.systemPrompt).toContain('{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE"');
    });

    it("a NON-GATE skill step is RELAXED — Output Format, no required verdict JSON", async () => {
      const store = createMockStore();
      const { executor } = makeExecutor(store);
      const cap = captureSession();

      await (executor as any).executeWorkflowStep(
        baseStepTask(),
        makeStep({ skillName: "compound-engineering:ce-plan", gateMode: "advisory" }),
        "/tmp/wt",
        {},
        undefined,
        undefined,
      );

      expect(cap.last?.systemPrompt).toContain("## Output Format");
      expect(cap.last?.systemPrompt).toContain("NOT required to end with a");
      expect(cap.last?.systemPrompt).not.toContain("## Feedback Format");
    });
  });
});
