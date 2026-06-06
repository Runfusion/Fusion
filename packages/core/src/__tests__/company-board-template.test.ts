// @vitest-environment node
//
// Company-model U3: the board column template (R1/R6, AE2). The template parses
// via parseWorkflowIr, carries the three locked role columns with company-model
// markers, and the non-coding variant omits the merge machinery so a task flows
// in-review → done with no merge-queue interaction (R6, AE2 shape).

import { describe, expect, it } from "vitest";
import {
  COMPANY_BOARD_TEMPLATE_IR,
  COMPANY_BOARD_TEMPLATE_NON_CODING_IR,
  COMPANY_BOARD_COLUMN_IDS,
  isCompanyBoardIr,
} from "../company-board-template.js";
import { parseWorkflowIr, serializeWorkflowIr } from "../workflow-ir.js";
import { resolveColumnFlags } from "../trait-registry.js";
// Side-effect import: registers the built-in traits so resolveColumnFlags can
// resolve merge/merge-blocker flags (mirrors the production import graph).
import "../builtin-traits.js";
import type { WorkflowIr, WorkflowIrColumn } from "../workflow-ir-types.js";

function columnById(ir: WorkflowIr, id: string): WorkflowIrColumn | undefined {
  if (ir.version !== "v2") return undefined;
  return ir.columns.find((c) => c.id === id);
}

describe("U3 company board template", () => {
  it("parses and round-trips (coding + non-coding)", () => {
    for (const ir of [COMPANY_BOARD_TEMPLATE_IR, COMPANY_BOARD_TEMPLATE_NON_CODING_IR]) {
      const parsed = parseWorkflowIr(ir);
      const reparsed = parseWorkflowIr(serializeWorkflowIr(parsed));
      expect(reparsed).toEqual(parsed);
      expect(parsed.version).toBe("v2");
    }
  });

  it("has NO triage column; entry is todo", () => {
    if (COMPANY_BOARD_TEMPLATE_IR.version !== "v2") throw new Error("expected v2");
    const ids = COMPANY_BOARD_TEMPLATE_IR.columns.map((c) => c.id);
    expect(ids).toEqual([...COMPANY_BOARD_COLUMN_IDS]);
    expect(ids).not.toContain("triage");
    // The start node sits in todo (not triage).
    const start = COMPANY_BOARD_TEMPLATE_IR.nodes.find((n) => n.kind === "start");
    expect(start?.column).toBe("todo");
  });

  it("carries the three locked role columns with role markers (R1)", () => {
    const todo = columnById(COMPANY_BOARD_TEMPLATE_IR, "todo");
    const inProgress = columnById(COMPANY_BOARD_TEMPLATE_IR, "in-progress");
    const inReview = columnById(COMPANY_BOARD_TEMPLATE_IR, "in-review");
    expect(todo?.role).toBe("lead");
    expect(todo?.locked).toBe(true);
    expect(inProgress?.role).toBe("executor");
    expect(inProgress?.locked).toBe(true);
    expect(inReview?.role).toBe("reviewer");
    expect(inReview?.locked).toBe(true);
    // Non-role columns carry no markers.
    expect(columnById(COMPANY_BOARD_TEMPLATE_IR, "done")?.role).toBeUndefined();
    expect(columnById(COMPANY_BOARD_TEMPLATE_IR, "archived")?.locked).toBeUndefined();
  });

  it("isCompanyBoardIr distinguishes company boards from legacy/custom workflows", () => {
    expect(isCompanyBoardIr(COMPANY_BOARD_TEMPLATE_IR)).toBe(true);
    expect(isCompanyBoardIr(COMPANY_BOARD_TEMPLATE_NON_CODING_IR)).toBe(true);
    // A plain custom workflow without role markers is NOT a company board.
    const plain = parseWorkflowIr({
      version: "v2",
      name: "plain",
      columns: [
        { id: "todo", name: "Todo", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [{ from: "start", to: "end" }],
    });
    expect(isCompanyBoardIr(plain)).toBe(false);
  });

  it("mirrors legacy trait semantics for the columns that exist (coding)", () => {
    const traitsFor = (id: string) =>
      (columnById(COMPANY_BOARD_TEMPLATE_IR, id)?.traits ?? []).map((t) => t.trait);
    expect(traitsFor("todo")).toEqual(["hold", "reset-on-entry"]);
    expect(traitsFor("in-progress")).toEqual(["wip", "abort-on-exit", "timing"]);
    expect(traitsFor("in-review")).toEqual(["merge-blocker", "stall-detection", "merge"]);
    expect(traitsFor("done")).toEqual(["complete"]);
    expect(traitsFor("archived")).toEqual(["archived"]);
  });

  it("AE2: non-coding in-review omits the merge machinery so done needs no merge", () => {
    const codingInReview = columnById(COMPANY_BOARD_TEMPLATE_IR, "in-review")!;
    const nonCodingInReview = columnById(COMPANY_BOARD_TEMPLATE_NON_CODING_IR, "in-review")!;

    // Trait-id level: the merge traits are present on coding, absent on non-coding.
    const nonCodingTraitIds = nonCodingInReview.traits.map((t) => t.trait);
    expect(nonCodingTraitIds).not.toContain("merge");
    expect(nonCodingTraitIds).not.toContain("merge-blocker");
    expect(nonCodingInReview.traits.map((t) => t.trait)).toContain("stall-detection");

    // Effective-flag level (the engine consults these): the coding in-review
    // participates in merge orchestration and blocks done until merge; the
    // non-coding one does neither — a task reaches done with no merge interaction.
    const codingFlags = resolveColumnFlags(codingInReview);
    const nonCodingFlags = resolveColumnFlags(nonCodingInReview);
    expect(codingFlags.mergeOrchestration).toBe(true);
    expect(codingFlags.mergeBlocker).toBe(true);
    expect(nonCodingFlags.mergeOrchestration).toBeUndefined();
    expect(nonCodingFlags.mergeBlocker).toBeUndefined();

    // The non-coding graph has no merge node at all.
    expect(COMPANY_BOARD_TEMPLATE_NON_CODING_IR.nodes.some((n) => n.config?.seam === "merge")).toBe(
      false,
    );
  });
});
