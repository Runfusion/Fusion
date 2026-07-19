/*
FNXC:WorkflowLifecycleTraits 2026-07-19-06:20 (U6 / KTD-10 / R8):
Unit coverage for the trait→column primitives that self-healing's trait re-key is
built on. The builtin:coding cases are the R8 evidence — every trait resolves to
exactly the legacy column id the old literals used, so a re-key keyed on these is
byte-identical on the default workflow. The custom cases prove KTD-10 fallback.
*/
import { describe, expect, it } from "vitest";
import "../builtin-traits.js"; // register built-in traits
import { BUILTIN_CODING_WORKFLOW_IR } from "../builtin-coding-workflow-ir.js";
import { columnsWithFlag, columnHasFlag, resolveReboundTarget, resolveCompleteColumn, resolveMergeOrchestrationColumn } from "../workflow-lifecycle-traits.js";
import type { WorkflowIr } from "../workflow-ir-types.js";

describe("columnsWithFlag — builtin:coding trait→columnIds (R8)", () => {
  const ir = BUILTIN_CODING_WORKFLOW_IR;
  it("maps each lifecycle trait to exactly the legacy column ids", () => {
    expect(columnsWithFlag(ir, "countsTowardWip")).toEqual(["in-progress"]);
    expect(columnsWithFlag(ir, "hold")).toEqual(["todo"]);
    expect(columnsWithFlag(ir, "intake")).toEqual(["triage"]);
    expect(columnsWithFlag(ir, "mergeOrchestration")).toEqual(["in-review"]);
    expect(columnsWithFlag(ir, "complete")).toEqual(["done"]);
    expect(columnsWithFlag(ir, "archived")).toEqual(["archived"]);
  });

  it("columnHasFlag agrees with the literal columns", () => {
    expect(columnHasFlag(ir, "in-progress", "countsTowardWip")).toBe(true);
    expect(columnHasFlag(ir, "todo", "hold")).toBe(true);
    expect(columnHasFlag(ir, "in-review", "mergeOrchestration")).toBe(true);
    expect(columnHasFlag(ir, "done", "complete")).toBe(true);
    expect(columnHasFlag(ir, "in-progress", "complete")).toBe(false);
    expect(columnHasFlag(ir, "nonexistent", "hold")).toBe(false);
  });
});

describe("resolveReboundTarget — KTD-10 ordering", () => {
  it("targets the hold column for builtin:coding (== legacy 'todo', R8 byte-identical)", () => {
    expect(resolveReboundTarget(BUILTIN_CODING_WORKFLOW_IR)).toBe("todo");
  });

  it("prefers hold, then intake, then the first column", () => {
    const holdWf: WorkflowIr = {
      version: "v2", name: "h",
      columns: [
        { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
        { id: "backlog", name: "Backlog", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "wip", name: "WIP", traits: [{ trait: "wip" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "inbox" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveReboundTarget(holdWf)).toBe("backlog"); // hold beats intake
  });

  it("falls back to the intake column when there is no hold column (custom workflow)", () => {
    const noHold: WorkflowIr = {
      version: "v2", name: "n",
      columns: [
        { id: "ideas", name: "Ideas", traits: [{ trait: "intake" }] },
        { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "ideas" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveReboundTarget(noHold)).toBe("ideas");
  });

  it("falls back to the first column when there is neither hold nor intake", () => {
    const bare: WorkflowIr = {
      version: "v2", name: "b",
      columns: [
        { id: "first", name: "First", traits: [] },
        { id: "second", name: "Second", traits: [{ trait: "wip" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "first" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveReboundTarget(bare)).toBe("first");
  });

  it("returns undefined for a column-less (v1) IR (caller keeps its literal fallback)", () => {
    const v1: WorkflowIr = { version: "v1", name: "v1", nodes: [{ id: "start", kind: "start" }], edges: [] } as WorkflowIr;
    expect(resolveReboundTarget(v1)).toBeUndefined();
  });
});

describe("resolveCompleteColumn / resolveMergeOrchestrationColumn — U7", () => {
  it("resolves to done / in-review for builtin:coding (R8 byte-identical)", () => {
    expect(resolveCompleteColumn(BUILTIN_CODING_WORKFLOW_IR)).toBe("done");
    expect(resolveMergeOrchestrationColumn(BUILTIN_CODING_WORKFLOW_IR)).toBe("in-review");
  });

  it("resolves a custom workflow's own complete + merge-orchestration columns (benchmark shape)", () => {
    const benchmark: WorkflowIr = {
      version: "v2", name: "benchmark",
      columns: [
        { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
        { id: "in-review", name: "In review", traits: [{ trait: "human-review" }] },
        { id: "merging", name: "Merging", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
        { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "todo" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveCompleteColumn(benchmark)).toBe("shipped");
    expect(resolveMergeOrchestrationColumn(benchmark)).toBe("merging");
  });

  it("returns undefined when the workflow declares no complete / merge column", () => {
    const bare: WorkflowIr = {
      version: "v2", name: "b",
      columns: [{ id: "only", name: "Only", traits: [] }],
      nodes: [{ id: "start", kind: "start", column: "only" }],
      edges: [],
    } as WorkflowIr;
    expect(resolveCompleteColumn(bare)).toBeUndefined();
    expect(resolveMergeOrchestrationColumn(bare)).toBeUndefined();
  });
});
