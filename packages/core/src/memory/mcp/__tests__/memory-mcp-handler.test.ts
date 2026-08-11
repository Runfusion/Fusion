import { describe, expect, it } from "vitest";
import { MemoryMcpHandler } from "../memory-mcp-handler.js";

const backends = {
  graphQuery: async () => [{ edge: { provenance: "extracted" } }], graphNeighbors: async () => [], graphShortestPath: async () => [], recallSearch: async () => [], recallAppend: async () => [{ id: "r" }],
};

describe("MemoryMcpHandler", () => {
  it("negotiates and executes every declared tool with the MCP result envelope", async () => {
    const handler = new MemoryMcpHandler(backends);
    const init = await handler.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(init?.result).toMatchObject({ protocolVersion: "2024-11-05", capabilities: { tools: {} } });
    const calls = [
      ["graph_query", {}], ["graph_neighbors", { nodeId: "n" }], ["graph_shortest_path", { fromId: "a", toId: "b" }], ["recall_search", { query: "q" }], ["recall_append", { kind: "decision", content: "c", source: { origin: "manual" } }],
    ] as const;
    for (const [name, arguments_] of calls) {
      const result = await handler.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      expect(result?.result).toMatchObject({ content: [{ type: "text" }] });
      expect((result?.result as Record<string, unknown>).structuredContent).toBeUndefined();
    }
  });
  it("separates protocol errors, tool errors, and notifications", async () => {
    const failing = new MemoryMcpHandler({ ...backends, recallAppend: async () => { throw new Error("duplicate SECRET_RECALL_CONTENT"); } });
    expect((await failing.handle({ jsonrpc: "2.0", id: 1, method: "nope" }))?.error?.code).toBe(-32601);
    expect((await failing.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } }))?.error?.code).toBe(-32602);
    // FNXC:MemoryMcp 2026-08-10-20:34: tools/call schema faults are protocol errors, so bad enum, array, and extra fields must not reach a backend.
    expect((await failing.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall_append", arguments: { kind: "other", content: "c", source: {} } } }))?.error).toMatchObject({ code: -32602, message: "Invalid kind" });
    expect((await failing.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_neighbors", arguments: { nodeId: "n", edgeKinds: ["contains", 4] } } }))?.error).toMatchObject({ code: -32602, message: "Invalid edgeKinds" });
    expect((await failing.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_query", arguments: { unexpected: true } } }))?.error).toMatchObject({ code: -32602, message: "Invalid unexpected" });
    const duplicateResult = await failing.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall_append", arguments: { kind: "decision", content: "c", source: {} } } });
    expect(duplicateResult?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(duplicateResult)).toContain("rejected as a duplicate");
    expect(JSON.stringify(duplicateResult)).not.toContain("SECRET_RECALL_CONTENT");
    await expect(failing.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeUndefined();
  });
});
