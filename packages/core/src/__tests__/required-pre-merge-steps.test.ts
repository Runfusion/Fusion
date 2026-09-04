import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { resolvePreMergeGateForTask, resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";

describe("resolveRequiredPreMergeStepIds", () => {
  it("includes default-on pre-merge groups when no explicit selection exists", () => {
    expect(resolveRequiredPreMergeStepIds(BUILTIN_CODING_WORKFLOW_IR, undefined))
      .toEqual(new Set(["plan-review", "code-review"]));
  });

  it("honours an explicit empty selection and excludes post-merge groups", () => {
    expect(resolveRequiredPreMergeStepIds(BUILTIN_CODING_WORKFLOW_IR, [])).toEqual(new Set());
    expect(resolveRequiredPreMergeStepIds(
      BUILTIN_CODING_WORKFLOW_IR,
      ["post-merge-verification"],
    )).toEqual(new Set());
  });

  it("includes explicitly enabled pre-merge groups regardless of their default", () => {
    expect(resolveRequiredPreMergeStepIds(
      BUILTIN_CODING_WORKFLOW_IR,
      ["browser-verification"],
    )).toEqual(new Set(["browser-verification"]));
  });

  it("removes Fast pre-merge requirements even when old selections still enable every group", () => {
    expect(resolveRequiredPreMergeStepIds(
      BUILTIN_CODING_WORKFLOW_IR,
      ["plan-review", "code-review", "browser-verification"],
      { executionMode: "fast" },
    )).toEqual(new Set());
  });

  it("keeps result-only semantics when the store cannot name a workflow", async () => {
    const gate = await resolvePreMergeGateForTask({
      getWorkflowDefinition: vi.fn(),
    } as never, "FN-180", undefined);

    expect(gate.resolution).toBe("not-workflow-aware");
    expect(gate.requiredPreMergeStepIds).toEqual(new Set());
  });

  it("requires default-on groups when a workflow-aware store reports no selection", async () => {
    const store = {
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getWorkflowDefinition: vi.fn(),
    };
    await expect(resolvePreMergeGateForTask(store as never, "FN-180", undefined)).resolves.toMatchObject({
      resolution: "no-selection",
      requiredPreMergeStepIds: new Set(["plan-review", "code-review"]),
    });
    await expect(resolvePreMergeGateForTask(store as never, "FN-180", [])).resolves.toMatchObject({
      resolution: "no-selection",
      requiredPreMergeStepIds: new Set(),
    });
  });

  it("distinguishes a failed selection read from legacy result-only resolution", async () => {
    const gate = await resolvePreMergeGateForTask({
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getTaskWorkflowSelectionAsync: vi.fn().mockRejectedValue(new Error("database unavailable")),
      getWorkflowDefinition: vi.fn(),
    } as never, "FN-180", undefined);

    expect(gate).toMatchObject({ resolution: "read-failed", provenance: "default", selectionAbsent: false });
  });

  it("retains the degraded-provenance refusal signal for an explicit selection", async () => {
    const gate = await resolvePreMergeGateForTask({
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "WF-missing", stepIds: [] })),
      getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    } as never, "FN-180", undefined);

    expect(gate).toMatchObject({ resolution: "selection", provenance: "default", selectionAbsent: false });
  });
});
