import { describe, expect, it } from "vitest";

import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { getBuiltinWorkflow } from "../workflows/builtin-workflows.js";
import {
  applyPromptOverridesToIr,
  enumeratePromptBearingWorkflowNodes,
  normalizeWorkflowPromptOverrides,
} from "../workflows/workflow-prompt-overrides.js";

describe("workflow prompt override overlay", () => {
  it("normalizes empty and whitespace overrides as absent", () => {
    expect(normalizeWorkflowPromptOverrides({ execute: "  ", review: "Review tightly", bad: 1 })).toEqual({
      review: "Review tightly",
    });
  });

  it("overlays prompt and gate nodes without mutating the shared built-in IR", () => {
    const reviewHeavy = getBuiltinWorkflow("builtin:review-heavy")!.ir;
    const before = JSON.stringify(reviewHeavy);

    const overlaid = applyPromptOverridesToIr(reviewHeavy, {
      execute: "Execute override",
      security: "Security gate override",
      end: "Ignored non-prompt node",
    });

    expect(overlaid).not.toBe(reviewHeavy);
    expect(overlaid.nodes.find((node) => node.id === "execute")?.config?.prompt).toBe("Execute override");
    expect(overlaid.nodes.find((node) => node.id === "security")?.config?.prompt).toBe("Security gate override");
    expect(JSON.stringify(reviewHeavy)).toBe(before);
  });

  it("returns the original IR when no override targets a prompt-bearing node", () => {
    expect(applyPromptOverridesToIr(BUILTIN_CODING_WORKFLOW_IR, { end: "ignored" })).toBe(BUILTIN_CODING_WORKFLOW_IR);
  });

  it("enumerates prompt defaults from inline IR prompt text", () => {
    const defaults = enumeratePromptBearingWorkflowNodes(getBuiltinWorkflow("builtin:lead-generation")!.ir);
    expect(defaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "qualification-gate", kind: "gate" }),
        expect.objectContaining({ nodeId: "enrich-lead", kind: "prompt" }),
      ]),
    );
    expect(defaults.find((entry) => entry.nodeId === "enrich-lead")?.prompt).toBe(
      getBuiltinWorkflow("builtin:lead-generation")!.ir.nodes.find((node) => node.id === "enrich-lead")?.config?.prompt,
    );
  });

  it("bakes non-seam prompt overrides into the IR node", () => {
    const ce = getBuiltinWorkflow("builtin:compound-engineering")!.ir;
    const overlaid = applyPromptOverridesToIr(ce, { plan: "Plan override" });
    expect(overlaid.nodes.find((node) => node.id === "plan")?.config?.prompt).toBe("Plan override");
  });
});
