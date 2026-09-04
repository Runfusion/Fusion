import { describe, expect, it } from "vitest";
import { parseWorkflowIr, WorkflowIrError } from "../workflows/workflow-ir.js";

function graph(config: Record<string, unknown> = {}) {
  return {
    version: "v2",
    name: "readonly-mcp",
    columns: [{ id: "todo", name: "Todo", traits: [] }],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "review", kind: "prompt", column: "todo", config: { prompt: "Review", ...config } },
      { id: "end", kind: "end", column: "todo" },
    ],
    edges: [{ from: "start", to: "review" }, { from: "review", to: "end" }],
  };
}

describe("readonlyMcpServers workflow config", () => {
  it("accepts an absent key and named servers", () => {
    expect(parseWorkflowIr(graph())).toBeDefined();
    expect(parseWorkflowIr(graph({ readonlyMcpServers: ["nav"] }))).toBeDefined();
  });

  it.each([
    [{ readonlyMcpServers: "nav" }],
    [{ readonlyMcpServers: [1] }],
    [{ readonlyMcpServers: [" "] }],
  ])("rejects invalid server lists", (config) => {
    expect(() => parseWorkflowIr(graph(config))).toThrow(WorkflowIrError);
    expect(() => parseWorkflowIr(graph(config))).toThrow("review");
  });
});
