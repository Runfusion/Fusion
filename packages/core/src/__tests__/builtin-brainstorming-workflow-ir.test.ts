import { describe, expect, it } from "vitest";
import { BUILTIN_BRAINSTORMING_WORKFLOW_IR } from "../builtin-brainstorming-workflow-ir.js";
import { parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";
import type { WorkflowIrV2 } from "../workflow-ir-types.js";

/*
FNXC:WorkflowBrainstorming 2026-07-05-00:00:
FN-7584 registers builtin:brainstorming as a discoverable built-in composing
FN-7579's ask-user -> refine -> exit-gate-on-approval phase ahead of the normal
coding plan/execute path. These tests pin the IR shape: it parses, orders the
brainstorm nodes before the plan/execute spine, and round-trips through
serialize/parse.
*/

describe("builtin brainstorming workflow IR", () => {
  it("parses through parseWorkflowIr", () => {
    expect(() => parseWorkflowIr(BUILTIN_BRAINSTORMING_WORKFLOW_IR)).not.toThrow();
    const ir = BUILTIN_BRAINSTORMING_WORKFLOW_IR as WorkflowIrV2;
    expect(ir.version).toBe("v2");
  });

  it("contains an ask-user and an exit-gate node ordered before the plan/execute spine", () => {
    const ir = BUILTIN_BRAINSTORMING_WORKFLOW_IR as WorkflowIrV2;

    const askUser = ir.nodes.find((node) => node.kind === "ask-user");
    const exitGate = ir.nodes.find((node) => node.kind === "exit-gate");
    expect(askUser?.id).toBe("brainstorm-ask");
    expect(exitGate?.id).toBe("brainstorm-exit");

    const startIndex = ir.nodes.findIndex((node) => node.id === "start");
    const askIndex = ir.nodes.findIndex((node) => node.id === "brainstorm-ask");
    const refineIndex = ir.nodes.findIndex((node) => node.id === "brainstorm-refine");
    const exitIndex = ir.nodes.findIndex((node) => node.id === "brainstorm-exit");
    const planIndex = ir.nodes.findIndex((node) => node.id === "plan");
    const parseIndex = ir.nodes.findIndex((node) => node.id === "parse");
    const stepsIndex = ir.nodes.findIndex((node) => node.id === "steps");

    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(askIndex).toBeGreaterThan(startIndex);
    expect(refineIndex).toBeGreaterThan(askIndex);
    expect(exitIndex).toBeGreaterThan(refineIndex);
    expect(planIndex).toBeGreaterThan(exitIndex);
    expect(parseIndex).toBeGreaterThan(planIndex);
    expect(stepsIndex).toBeGreaterThan(parseIndex);

    // Graph wiring: start feeds the brainstorm loop, and the exit-gate's
    // outcome:exit edge is what rejoins the unmodified plan/execute spine.
    expect(ir.edges).toContainEqual({ from: "start", to: "brainstorm-ask", condition: "success" });
    expect(ir.edges).toContainEqual({ from: "brainstorm-ask", to: "brainstorm-refine", condition: "success" });
    expect(ir.edges).toContainEqual({ from: "brainstorm-refine", to: "brainstorm-exit", condition: "success" });
    expect(ir.edges).toContainEqual({ from: "brainstorm-exit", to: "plan", condition: "outcome:exit" });
    expect(ir.edges).toContainEqual({
      from: "brainstorm-exit",
      to: "brainstorm-ask",
      condition: "outcome:continue",
      kind: "rework",
    });

    // The exit-gate's rework edge targets a declared top-level rework-region head.
    expect(askUser?.config?.reworkRegion).toBe(true);
    expect(typeof askUser?.config?.maxReworkCycles).toBe("number");

    // ask-user carries a non-empty question (validator-enforced when present).
    expect(typeof askUser?.config?.question).toBe("string");
    expect((askUser?.config?.question as string).trim().length).toBeGreaterThan(0);
  });

  it("round-trips serialize -> parse to identical bytes", () => {
    const serialized = serializeWorkflowIr(BUILTIN_BRAINSTORMING_WORKFLOW_IR);
    const reparsed = parseWorkflowIr(serialized);
    expect(serializeWorkflowIr(reparsed)).toBe(serialized);
  });

  it("carries the shared built-in workflow settings", () => {
    const ir = BUILTIN_BRAINSTORMING_WORKFLOW_IR as WorkflowIrV2;
    expect(ir.settings?.some((setting) => setting.id === "planReviewMaxRevisions")).toBe(true);
    expect(ir.settings?.some((setting) => setting.id === "codeReviewMaxRevisions")).toBe(true);
  });
});
