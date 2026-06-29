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
import { BUILTIN_WORKFLOWS } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
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
  return workflow.ir.nodes
    .filter((node: any) => typeof node.config?.skillName === "string" && node.config.skillName.trim())
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

    it("acquires a task worktree when the first CE coding-mode node runs before execute", async () => {
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

      const result = await (executor as any).runGraphCustomNode(node, { id: "FN-CE-1" }, await store.getSettings(), undefined);

      expect(result.outcome).toBe("success");
      expect((executor as any).createWorktree).toHaveBeenCalled();
      expect(captured.worktreePath).toBe("/tmp/test/.worktrees/swift-falcon");
      expect(captured.step.toolMode).toBe("coding");
      expect(live.worktree).toBe("/tmp/test/.worktrees/swift-falcon");
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
        "compound-engineering:ce-work",
        "compound-engineering:ce-code-review",
        "compound-engineering:ce-commit-push-pr",
        "compound-engineering:ce-resolve-pr-feedback",
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
