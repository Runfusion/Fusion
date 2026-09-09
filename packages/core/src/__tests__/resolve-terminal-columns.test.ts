/*
FNXC:TaskArchiveRemoval 2026-09-04-10:36:
Terminal task resolution is complete-only. Custom workflows use their `complete` column and malformed or legacy inputs fall back to `done`; archived is never a workflow role or terminal target.
*/
import { describe, expect, it } from "vitest";
import "../index.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { resolveTerminalColumns } from "../workflows/workflow-lifecycle-traits.js";

function ir(columns: Array<{ id: string; trait: string }>): WorkflowIr {
  return {
    version: "v2",
    id: "custom:terminal-test",
    name: "terminal-test",
    columns: columns.map((column) => ({ id: column.id, name: column.id, traits: [{ trait: column.trait }] })),
    nodes: [
      { id: "start", kind: "start", column: columns[0]?.id },
      { id: "end", kind: "end", column: columns[columns.length - 1]?.id },
    ],
    edges: [{ from: "start", to: "end" }],
  } as WorkflowIr;
}

describe("resolveTerminalColumns", () => {
  it("returns the renamed complete column", () => {
    expect(resolveTerminalColumns(ir([{ id: "shipped", trait: "complete" }]))).toEqual(["shipped"]);
  });

  it("falls back to done when no complete trait is declared", () => {
    expect(resolveTerminalColumns(ir([{ id: "backlog", trait: "hold" }]))).toEqual(["done"]);
  });

  it("resolves the built-in vocabulary to done", () => {
    expect(resolveTerminalColumns(ir([{ id: "done", trait: "complete" }]))).toEqual(["done"]);
  });
});
