import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  DEFAULT_WORKFLOW_COLUMN_IDS,
  parseWorkflowIr,
  serializeWorkflowIr,
} from "../index.js";

describe("builtin coding workflow ir", () => {
  it("parses and round-trips", () => {
    const parsed = parseWorkflowIr(BUILTIN_CODING_WORKFLOW_IR);
    const reparsed = parseWorkflowIr(serializeWorkflowIr(parsed));
    expect(reparsed).toEqual(parsed);
    // The built-in default workflow is now a v2 graph (columns + placement).
    expect(parsed.version).toBe("v2");
  });

  it("contains exactly one start and one end node", () => {
    const nodes = BUILTIN_CODING_WORKFLOW_IR.nodes;
    expect(nodes.filter((node) => node.kind === "start")).toHaveLength(1);
    expect(nodes.filter((node) => node.kind === "end")).toHaveLength(1);
  });

  it("exposes coding lifecycle seams", () => {
    const seams = BUILTIN_CODING_WORKFLOW_IR.nodes
      .map((node) => String(node.config?.seam ?? ""))
      .filter((seam) => seam.length > 0);
    expect(seams).toEqual(expect.arrayContaining(["execute", "review", "merge"]));
    expect(seams).not.toContain("triage");
  });

  it("defines the six legacy columns in legacy order (KTD-1)", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.version).toBe("v2");
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    const ids = BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => c.id);
    expect(ids).toEqual([...DEFAULT_WORKFLOW_COLUMN_IDS]);
    expect(ids).toEqual(["triage", "todo", "in-progress", "in-review", "done", "archived"]);
  });

  it("maps default-workflow traits to columns verbatim (R12)", () => {
    if (BUILTIN_CODING_WORKFLOW_IR.version !== "v2") throw new Error("expected v2");
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.columns.map((c) => [c.id, c]));
    const traitsFor = (id: string) => byId.get(id)!.traits.map((t) => t.trait);
    expect(traitsFor("triage")).toEqual(["intake"]);
    expect(traitsFor("todo")).toEqual(["hold", "reset-on-entry"]);
    expect(traitsFor("in-progress")).toEqual(["wip", "abort-on-exit", "timing"]);
    expect(traitsFor("in-review")).toEqual(["merge-blocker", "stall-detection", "merge"]);
    expect(traitsFor("done")).toEqual(["complete"]);
    expect(traitsFor("archived")).toEqual(["archived"]);
    // todo's hold is capacity-released (legacy "pull from todo when a slot frees").
    const hold = byId.get("todo")!.traits.find((t) => t.trait === "hold");
    expect(hold?.config?.release).toBe("capacity");
  });

  it("places seam nodes in their columns", () => {
    const byId = new Map(BUILTIN_CODING_WORKFLOW_IR.nodes.map((n) => [n.id, n]));
    expect(byId.get("execute")?.column).toBe("in-progress");
    expect(byId.get("review")?.column).toBe("in-review");
    expect(byId.get("merge")?.column).toBe("in-review");
  });
});
