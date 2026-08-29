import { describe, expect, it } from "vitest";
import {
  BUILTIN_TRAIT_DEFINITIONS,
  BUILTIN_TRAIT_IDS,
  registerBuiltinTraits,
} from "../workflows/builtin-traits.js";
import { TraitRegistry } from "../workflows/trait-registry.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "../workflows/builtin-stepwise-coding-workflow-ir.js";
import type { WorkflowIrV2 } from "../workflows/workflow-ir-types.js";

function freshRegistry(): TraitRegistry {
  const r = new TraitRegistry();
  registerBuiltinTraits(r);
  return r;
}

describe("built-in traits", () => {
  it("ships exactly the 14 vocabulary traits", () => {
    expect(BUILTIN_TRAIT_IDS).toHaveLength(14);
    expect(BUILTIN_TRAIT_DEFINITIONS.map((d) => d.id).sort()).toEqual([...BUILTIN_TRAIT_IDS].sort());
  });

  it("all built-ins are flagged builtin: true and register cleanly", () => {
    const r = freshRegistry();
    for (const id of BUILTIN_TRAIT_IDS) {
      const def = r.getTrait(id);
      expect(def, `missing built-in trait ${id}`).toBeDefined();
      expect(def?.builtin).toBe(true);
    }
    expect(r.listTraits()).toHaveLength(14);
  });

  it("only built-in traits carry restricted capabilities", () => {
    const r = freshRegistry();
    expect(r.getTrait("complete")?.flags.complete).toBe(true);
    expect(r.getTrait("archived")?.flags.archived).toBe(true);
    // Sync guards live only on built-ins (merge-blocker, human-review).
    expect(r.getTrait("merge-blocker")?.hooks?.guard).toBe(true);
    expect(r.getTrait("human-review")?.hooks?.guard).toBe(true);
    // The plugin-facing gate trait uses the async gate hook, not a sync guard.
    expect(r.getTrait("gate")?.hooks?.guard).toBeUndefined();
    expect(r.getTrait("gate")?.hooks?.gate).toBe(true);
  });

  it("merge trait config schema matches the U7 policy fields", () => {
    const r = freshRegistry();
    const fields = r.getTrait("merge")?.configSchema?.fields ?? [];
    const keys = fields.map((f) => f.key).sort();
    // U7 tightened the schema: strategy enum, fileScope enum (incl. custom),
    // custom-rules array, squash posture, conflictStrategy.
    expect(keys).toEqual(["conflictStrategy", "fileScope", "rules", "squash", "strategy"]);
    expect(r.getTrait("merge")?.flags.mergeOrchestration).toBe(true);

    const strategy = fields.find((f) => f.key === "strategy");
    expect(strategy?.enumValues).toEqual(["always-squash", "auto", "always-rebase", "pr-only"]);
    const fileScope = fields.find((f) => f.key === "fileScope");
    expect(fileScope?.enumValues).toEqual(["strict", "warn", "off", "custom"]);
  });

  it("hold trait's release config matches WorkflowHoldRelease kinds", () => {
    const r = freshRegistry();
    const release = r.getTrait("hold")?.configSchema?.fields.find((f) => f.key === "release");
    expect(release?.enumValues).toEqual([
      "manual",
      "timer",
      "capacity",
      "dependency",
      "external-event",
    ]);
  });

  it("registering built-ins twice into the same registry is idempotent", () => {
    const r = freshRegistry();
    expect(() => registerBuiltinTraits(r)).not.toThrow();
    expect(r.listTraits()).toHaveLength(14);
  });
});

describe("default workflow columns validate cleanly", () => {
  it("BUILTIN_CODING_WORKFLOW_IR columns pass the composition validator", () => {
    const r = freshRegistry();
    const ir = BUILTIN_CODING_WORKFLOW_IR as WorkflowIrV2;
    const violations = r.validateColumnTraits(ir.columns, "save");
    expect(violations).toEqual([]);
  });

  it("the default workflow has exactly one intake column (triage)", () => {
    const r = freshRegistry();
    const ir = BUILTIN_CODING_WORKFLOW_IR as WorkflowIrV2;
    const intakeCols = ir.columns.filter((c) => r.resolveColumnFlags(c).intake);
    expect(intakeCols.map((c) => c.id)).toEqual(["triage"]);
  });

  it("the default workflow's done column resolves the complete flag", () => {
    const r = freshRegistry();
    const ir = BUILTIN_CODING_WORKFLOW_IR as WorkflowIrV2;
    const done = ir.columns.find((c) => c.id === "done")!;
    expect(r.resolveColumnFlags(done).complete).toBe(true);
  });

  it("the default workflow's in-progress column resolves wip+abort+timing flags", () => {
    const r = freshRegistry();
    const ir = BUILTIN_CODING_WORKFLOW_IR as WorkflowIrV2;
    const inProgress = ir.columns.find((c) => c.id === "in-progress")!;
    const flags = r.resolveColumnFlags(inProgress);
    expect(flags.countsTowardWip).toBe(true);
    expect(flags.abortOnExit).toBe(true);
    expect(flags.timing).toBe(true);
  });

  it("wip trait schema supports explicit settings-backed limits", () => {
    const r = freshRegistry();
    const fields = r.getTrait("wip")?.configSchema?.fields ?? [];
    const limitSetting = fields.find((field) => field.key === "limitSetting");
    expect(limitSetting?.type).toBe("enum");
    expect(limitSetting?.enumValues).toEqual(["maxConcurrent"]);
  });

  it("the default workflow's in-review column resolves review and merge flags", () => {
    const r = freshRegistry();
    const ir = BUILTIN_CODING_WORKFLOW_IR as WorkflowIrV2;
    const inReview = ir.columns.find((c) => c.id === "in-review")!;
    const flags = r.resolveColumnFlags(inReview);
    expect(flags.mergeBlocker).toBe(true);
    expect(flags.humanReview).toBe(true);
    expect(flags.mergeOrchestration).toBe(true);
  });

  it("the stepwise workflow's in-review column resolves review and merge flags", () => {
    const r = freshRegistry();
    const ir = BUILTIN_STEPWISE_CODING_WORKFLOW_IR as WorkflowIrV2;
    const inReview = ir.columns.find((c) => c.id === "in-review")!;
    const flags = r.resolveColumnFlags(inReview);
    expect(flags.mergeBlocker).toBe(true);
    expect(flags.humanReview).toBe(true);
    expect(flags.mergeOrchestration).toBe(true);
  });
});
