import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  BUILTIN_WORKFLOWS,
  defaultEnabledBuiltinWorkflowIds,
  getBuiltinWorkflow,
  isBuiltinWorkflowId,
} from "../builtin-workflows.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "../builtin-workflow-settings.js";
import { resolveColumnFlags } from "../trait-registry.js";
import { compileWorkflowToSteps } from "../workflow-compiler.js";
import { DEFAULT_WORKFLOW_COLUMN_IDS, parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

const EXECUTE_NODE_MAX_RETRIES = 2;

describe("built-in workflows", () => {
  // Graph-only built-ins (step inversion, KTD-9) model branching/foreach/rework
  // structure the linear compiler cannot lower to a step list — they run only
  // under the workflow graph executor. They still must parse as valid IR.
  const GRAPH_ONLY_BUILTIN_IDS = new Set(["builtin:stepwise-coding", "builtin:pr-workflow"]);

  it("every built-in has a valid IR; linear built-ins compile without error", () => {
    expect(BUILTIN_WORKFLOWS.length).toBeGreaterThanOrEqual(4);
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(isBuiltinWorkflowId(wf.id)).toBe(true);
      expect(() => parseWorkflowIr(wf.ir)).not.toThrow();
      if (!GRAPH_ONLY_BUILTIN_IDS.has(wf.id)) {
        expect(() => compileWorkflowToSteps(wf.ir)).not.toThrow();
      }
    }
  });

  it("includes the stepwise coding built-in modeling step inversion (KTD-9)", () => {
    const stepwise = getBuiltinWorkflow("builtin:stepwise-coding");
    expect(stepwise).toBeDefined();
    const ir = parseWorkflowIr(stepwise!.ir);
    if (ir.version !== "v2") throw new Error("expected v2");
    // The chain: a parse-steps node dominating a foreach with a step-review template.
    expect(ir.nodes.some((n) => n.kind === "parse-steps")).toBe(true);
    const foreach = ir.nodes.find((n) => n.kind === "foreach");
    expect(foreach).toBeDefined();
    const template = (
      foreach!.config as { template: { nodes: Array<{ kind: string; config?: { seam?: string } }> } }
    ).template;
    expect(template.nodes.some((n) => n.kind === "step-review")).toBe(true);
    expect(template.nodes.some((n) => n.config?.seam === "step-execute")).toBe(true);
  });

  it("includes the PR lifecycle built-in wiring the PR nodes end to end (U9)", () => {
    const pr = getBuiltinWorkflow("builtin:pr-workflow");
    expect(pr).toBeDefined();
    const ir = parseWorkflowIr(pr!.ir);
    if (ir.version !== "v2") throw new Error("expected v2");

    // The three PR node kinds plus the await holds are all present.
    const kinds = ir.nodes.map((n) => n.kind);
    expect(kinds).toContain("pr-create");
    expect(kinds).toContain("pr-respond");
    expect(kinds).toContain("pr-merge");
    expect(ir.nodes.filter((n) => n.kind === "hold").length).toBeGreaterThanOrEqual(3);

    // The auto-merge gate (U6) routes after approval.
    expect(ir.nodes.some((n) => n.kind === "gate" && (n.config as { gate?: string })?.gate === "auto-merge")).toBe(true);

    // await-review is the bounded-rework region head; pr-respond loops back to it.
    const awaitReview = ir.nodes.find((n) => n.id === "await-review");
    expect((awaitReview?.config as { reworkRegion?: boolean })?.reworkRegion).toBe(true);
    expect((awaitReview?.config as { release?: string })?.release).toBe("external-event");
    expect(
      ir.edges.some((e) => e.from === "pr-respond" && e.to === "await-review" && e.kind === "rework"),
    ).toBe(true);

    // The create→await-review→gate→merge→end spine exists.
    expect(ir.edges.some((e) => e.from === "pr-create" && e.to === "await-review")).toBe(true);
    expect(ir.edges.some((e) => e.from === "await-review" && e.to === "gate")).toBe(true);
    expect(ir.edges.some((e) => e.from === "gate" && e.to === "pr-merge")).toBe(true);
    expect(ir.edges.some((e) => e.from === "pr-merge" && e.to === "end")).toBe(true);
  });

  it("the PR built-in IR round-trips through serialize → parse unchanged (U9)", () => {
    const pr = getBuiltinWorkflow("builtin:pr-workflow")!;
    const serialized = serializeWorkflowIr(pr.ir);
    const reparsed = parseWorkflowIr(serialized);
    // Re-serializing the reparsed IR yields the identical bytes (stable round-trip).
    expect(serializeWorkflowIr(reparsed)).toBe(serialized);
  });

  it("default workflow column ids equal the legacy enum values, in legacy order (KTD-1)", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    expect(BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => c.id)).toEqual([
      ...DEFAULT_WORKFLOW_COLUMN_IDS,
    ]);
  });

  it("builtin:coding catalog entry is backed by the canonical coding IR", () => {
    const coding = getBuiltinWorkflow("builtin:coding");
    expect(coding).toBeDefined();
    expect(coding!.id).toBe("builtin:coding");
    expect(coding!.name).toBe("Coding (built-in)");
    expect(coding!.description).toContain("standard coding pipeline");
    expect(coding!.kind).toBe("workflow");
    expect(coding!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(coding!.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(coding!.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(serializeWorkflowIr(coding!.ir)).toBe(serializeWorkflowIr(BUILTIN_CODING_WORKFLOW_IR));
  });

  it("builtin:coding catalog IR exposes canonical columns, placements, and settings", () => {
    const coding = getBuiltinWorkflow("builtin:coding")!;
    const ir = parseWorkflowIr(coding.ir);
    expect(ir.version).toBe("v2");
    if (ir.version !== "v2") throw new Error("expected v2");

    expect(ir.columns.map((column) => column.id)).toEqual([
      "triage",
      "todo",
      "in-progress",
      "in-review",
      "done",
      "archived",
    ]);
    expect(ir.columns.map((column) => column.traits.map((trait) => trait.trait))).toEqual([
      ["intake"],
      ["hold", "reset-on-entry"],
      ["wip", "abort-on-exit", "timing"],
      ["merge-blocker", "human-review", "stall-detection", "merge"],
      ["complete"],
      ["archived"],
    ]);

    const byId = new Map(ir.nodes.map((node) => [node.id, node]));
    expect(byId.get("execute")?.column).toBe("in-progress");
    expect(byId.get("review")?.column).toBe("in-review");
    expect(byId.get("merge")?.column).toBe("in-review");
    expect(ir.settings).toEqual(BUILTIN_WORKFLOW_SETTINGS);
  });

  it("repeated catalog reads and listings keep builtin:coding in the enabled order", () => {
    expect(getBuiltinWorkflow("builtin:coding")?.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(getBuiltinWorkflow("builtin:coding")?.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(BUILTIN_WORKFLOWS.find((workflow) => workflow.id === "builtin:coding")?.ir).toBe(BUILTIN_CODING_WORKFLOW_IR);
    expect(defaultEnabledBuiltinWorkflowIds()).toEqual(BUILTIN_WORKFLOWS.map((workflow) => workflow.id));
    expect(defaultEnabledBuiltinWorkflowIds().slice(0, 5)).toEqual([
      "builtin:coding",
      "builtin:quick-fix",
      "builtin:review-heavy",
      "builtin:compound-engineering",
      "builtin:stepwise-coding",
    ]);
  });

  it("builtin:coding exposes execute retries after registry lookup and parse round-trip", () => {
    const coding = getBuiltinWorkflow("builtin:coding");
    expect(coding).toBeDefined();
    const ir = parseWorkflowIr(coding!.ir);
    const reparsed = parseWorkflowIr(serializeWorkflowIr(ir));

    for (const candidate of [ir, reparsed]) {
      const executeNodes = candidate.nodes.filter((node) => node.id === "execute" && node.config?.seam === "execute");
      expect(executeNodes).toHaveLength(1);
      const executeConfig = executeNodes[0].config;
      expect(executeConfig).toBeDefined();
      expect(Object.keys(executeConfig ?? {})).not.toHaveLength(0);
      expect(executeConfig?.maxRetries).toBe(EXECUTE_NODE_MAX_RETRIES);
      expect(Number.isInteger(executeConfig?.maxRetries)).toBe(true);
      expect(executeConfig?.maxRetries).toBeGreaterThanOrEqual(1);
      expect(executeConfig?.maxRetries).toBeLessThanOrEqual(10);

      const byId = new Map(candidate.nodes.map((node) => [node.id, node]));
      expect(byId.get("review")?.config?.name).toBe("Review");
      expect(byId.get("merge")?.config?.name).toBe("Merge boundary");
      expect(byId.get("review")?.config?.maxRetries).toBeUndefined();
      expect(byId.get("merge")?.config?.maxRetries).toBeUndefined();
    }
  });

  it("builtin:coding exposes merge-blocker and human-review traits on in-review", () => {
    const coding = getBuiltinWorkflow("builtin:coding");
    expect(coding).toBeDefined();
    const ir = parseWorkflowIr(coding!.ir);
    expect(ir.version).toBe("v2");
    if (ir.version !== "v2") throw new Error("expected v2");

    const inReview = ir.columns.find((column) => column.id === "in-review");
    expect(inReview).toBeDefined();
    expect(inReview!.traits.length).toBeGreaterThan(0);
    expect(inReview!.traits.map((trait) => trait.trait)).toContain("merge-blocker");
    expect(inReview!.traits.map((trait) => trait.trait)).toContain("human-review");

    const flags = resolveColumnFlags(inReview!);
    expect(flags.mergeBlocker).toBe(true);
    expect(flags.humanReview).toBe(true);
  });

  it("includes a coding and a compound-engineering workflow", () => {
    expect(getBuiltinWorkflow("builtin:coding")).toBeDefined();
    expect(getBuiltinWorkflow("builtin:compound-engineering")).toBeDefined();
  });

  it("all seam nodes carry a descriptive name", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      const visitNodes = (nodes: Array<{ config?: unknown; id: string }>) => {
        for (const node of nodes) {
          const config = node.config as { seam?: unknown; name?: unknown } | undefined;
          if (typeof config?.seam === "string") {
            expect(typeof config.name).toBe("string");
            expect(String(config.name).trim().length).toBeGreaterThan(0);
          }
        }
      };

      visitNodes(workflow.ir.nodes);
      if (workflow.ir.version === "v2") {
        for (const node of workflow.ir.nodes) {
          if (node.kind !== "foreach") continue;
          const template = (node.config as { template?: { nodes?: Array<{ config?: unknown; id: string }> } } | undefined)
            ?.template;
          if (template?.nodes) visitNodes(template.nodes);
        }
      }
    }
  });

  it("compound-engineering compiles its skill nodes to steps", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!;
    const steps = compileWorkflowToSteps(ce.ir);
    // plan + code-review (pre-merge) + document (post-merge) — seams are skipped.
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.some((s) => s.name === "Plan")).toBe(true);
  });

  describe("store integration", () => {
    const harness = createTaskStoreTestHarness();
    let store: ReturnType<typeof harness.store>;
    beforeEach(async () => {
      await harness.beforeEach();
      store = harness.store();
    });
    afterEach(async () => {
      await harness.afterEach();
    });

    it("lists built-ins ahead of user workflows and resolves them by id", async () => {
      const list = await store.listWorkflowDefinitions();
      expect(list[0].id.startsWith("builtin:")).toBe(true);
      expect(await store.getWorkflowDefinition("builtin:coding")).toBeDefined();
    });

    it("filters disabled built-ins from normal listings but keeps direct resolution", async () => {
      await store.updateSettings({ enabledBuiltinWorkflowIds: ["builtin:coding"] });

      const list = await store.listWorkflowDefinitions();
      expect(list.filter((workflow) => workflow.id.startsWith("builtin:")).map((workflow) => workflow.id)).toEqual([
        "builtin:coding",
      ]);
      expect(await store.getWorkflowDefinition("builtin:compound-engineering")).toBeDefined();
    });

    it("can include disabled built-ins for workflow management surfaces", async () => {
      await store.updateSettings({ enabledBuiltinWorkflowIds: [] });

      const normalList = await store.listWorkflowDefinitions();
      expect(normalList.some((workflow) => workflow.id.startsWith("builtin:"))).toBe(false);

      const managementList = await store.listWorkflowDefinitions({ includeDisabledBuiltins: true });
      expect(managementList.some((workflow) => workflow.id === "builtin:coding")).toBe(true);
      expect(managementList.some((workflow) => workflow.id === "builtin:compound-engineering")).toBe(true);
    });

    it("shows the built-in seam prompt text in node config", () => {
      const coding = getBuiltinWorkflow("builtin:coding");
      const execute = coding?.ir.nodes.find((node) => node.id === "execute");
      const review = coding?.ir.nodes.find((node) => node.id === "review");
      const merge = coding?.ir.nodes.find((node) => node.id === "merge");

      expect((execute?.config as { prompt?: string } | undefined)?.prompt).toContain("You are a task execution agent");
      expect((review?.config as { prompt?: string } | undefined)?.prompt).toContain("You are an independent code and plan reviewer");
      expect((merge?.config as { prompt?: string } | undefined)?.prompt).toContain("You are a merge agent");
    });

    it("rejects editing or deleting a built-in", async () => {
      await expect(
        store.updateWorkflowDefinition("builtin:coding", { name: "x" }),
      ).rejects.toThrow(/cannot be edited/i);
      await expect(store.deleteWorkflowDefinition("builtin:coding")).rejects.toThrow(/cannot be deleted/i);
    });

    it("a task can select a built-in workflow", async () => {
      const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
      await store.selectTaskWorkflow(task.id, "builtin:compound-engineering");
      expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe("builtin:compound-engineering");
    });
  });
});
