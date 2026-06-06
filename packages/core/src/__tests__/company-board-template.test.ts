// @vitest-environment node
//
// Company-model U3: the board column template (R1/R5/R6). The template parses via
// parseWorkflowIr, carries an unstaffed locked `idea` intake column before todo,
// the three locked role columns with company-model markers, and keeps the full
// merge machinery (R6 — no merge-less variant).

import { describe, expect, it } from "vitest";
import {
  COMPANY_BOARD_TEMPLATE_IR,
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
  it("parses and round-trips", () => {
    const parsed = parseWorkflowIr(COMPANY_BOARD_TEMPLATE_IR);
    const reparsed = parseWorkflowIr(serializeWorkflowIr(parsed));
    expect(reparsed).toEqual(parsed);
    expect(parsed.version).toBe("v2");
  });

  it("has NO triage column; an idea intake column leads, todo is the working entry", () => {
    if (COMPANY_BOARD_TEMPLATE_IR.version !== "v2") throw new Error("expected v2");
    const ids = COMPANY_BOARD_TEMPLATE_IR.columns.map((c) => c.id);
    expect(ids).toEqual([...COMPANY_BOARD_COLUMN_IDS]);
    expect(ids).not.toContain("triage");
    expect(ids[0]).toBe("idea");
    expect(ids[1]).toBe("todo");
    // The start node sits in todo (not idea, not triage) — idea is intake-only.
    const start = COMPANY_BOARD_TEMPLATE_IR.nodes.find((n) => n.kind === "start");
    expect(start?.column).toBe("todo");
  });

  it("the idea column is locked, unstaffed, and carries no role marker (R5)", () => {
    const idea = columnById(COMPANY_BOARD_TEMPLATE_IR, "idea");
    expect(idea).toBeTruthy();
    expect(idea?.locked).toBe(true);
    expect(idea?.role).toBeUndefined();
    expect(idea?.agent).toBeUndefined();
    expect((idea?.traits ?? []).map((t) => t.trait)).toEqual(["intake"]);
    // No automation node lives in the idea column.
    expect(COMPANY_BOARD_TEMPLATE_IR.nodes.some((n) => n.column === "idea")).toBe(false);
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
    // Non-role tail columns carry no markers.
    expect(columnById(COMPANY_BOARD_TEMPLATE_IR, "done")?.role).toBeUndefined();
    expect(columnById(COMPANY_BOARD_TEMPLATE_IR, "archived")?.locked).toBeUndefined();
  });

  it("isCompanyBoardIr distinguishes company boards from legacy/custom workflows", () => {
    expect(isCompanyBoardIr(COMPANY_BOARD_TEMPLATE_IR)).toBe(true);
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

  it("mirrors legacy trait semantics for the columns that exist", () => {
    const traitsFor = (id: string) =>
      (columnById(COMPANY_BOARD_TEMPLATE_IR, id)?.traits ?? []).map((t) => t.trait);
    expect(traitsFor("idea")).toEqual(["intake"]);
    expect(traitsFor("todo")).toEqual(["hold", "reset-on-entry"]);
    expect(traitsFor("in-progress")).toEqual(["wip", "abort-on-exit", "timing"]);
    expect(traitsFor("in-review")).toEqual(["merge-blocker", "stall-detection", "merge"]);
    expect(traitsFor("done")).toEqual(["complete"]);
    expect(traitsFor("archived")).toEqual(["archived"]);
  });

  it("R6: every company board keeps the full merge machinery", () => {
    const inReview = columnById(COMPANY_BOARD_TEMPLATE_IR, "in-review")!;
    const flags = resolveColumnFlags(inReview);
    expect(flags.mergeOrchestration).toBe(true);
    expect(flags.mergeBlocker).toBe(true);
    // The merge node is present in the graph.
    expect(COMPANY_BOARD_TEMPLATE_IR.nodes.some((n) => n.config?.seam === "merge")).toBe(true);
  });
});
