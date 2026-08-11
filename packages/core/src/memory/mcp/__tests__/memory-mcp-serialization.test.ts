import { describe, expect, it } from "vitest";
import { buildToolOutputTruncationMarker, DEFAULT_TOOL_OUTPUT_MAX_CHARS } from "../../../tool-output-budget.js";
import { CLAMP_PREFIX, MEMORY_TOOL_MIN_TEXT_BUDGET, MEMORY_TOOL_TRUNCATION_HINT, resolveMemoryToolBudget, serializeMemoryMcpResult } from "../memory-mcp-serialization.js";

describe("memory MCP serialization", () => {
  it("drops whole tail results before producing parseable JSON", () => {
    const output = serializeMemoryMcpResult("graph_query", [{ provenance: "extracted", text: "x".repeat(100) }, { provenance: "inferred", text: "y".repeat(100) }], 300);
    expect(output.text.length).toBeLessThanOrEqual(300);
    expect(JSON.parse(output.text)).toMatchObject({ truncated: true, omittedCount: 1, results: [{ provenance: "extracted" }] });
  });
  it("uses the marker-aware non JSON fallback for one oversized result", () => {
    const output = serializeMemoryMcpResult("graph_query", [{ provenance: "extracted", text: "x".repeat(500) }], MEMORY_TOOL_MIN_TEXT_BUDGET);
    expect(output.text.length).toBeLessThanOrEqual(MEMORY_TOOL_MIN_TEXT_BUDGET);
    expect(output.text.startsWith(CLAMP_PREFIX)).toBe(true);
    expect(output.text.split(buildToolOutputTruncationMarker(MEMORY_TOOL_TRUNCATION_HINT)).length - 1).toBe(1);
    expect(() => JSON.parse(output.text)).toThrow();
  });
  it("floors finite settings and preserves the unlimited sentinel", () => {
    expect(resolveMemoryToolBudget({ agentToolOutputMaxChars: 1 }, undefined, "graph_query")).toBe(MEMORY_TOOL_MIN_TEXT_BUDGET);
    expect(resolveMemoryToolBudget({ agentToolOutputMaxChars: 0 }, undefined, "graph_query")).toBeNull();
    expect(resolveMemoryToolBudget({}, undefined, "graph_query")).toBe(DEFAULT_TOOL_OUTPUT_MAX_CHARS);
  });
});
