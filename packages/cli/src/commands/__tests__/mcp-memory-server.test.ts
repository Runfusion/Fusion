import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOL_OUTPUT_MAX_CHARS } from "@fusion/core";
import { runMemoryMcpServerLoop } from "../mcp-memory-server.js";

const edge = { id: "edge:one", provenance: "inferred", from: "a", to: "b" };

function createBackends() {
  return {
    graphQuery: vi.fn(async () => [{ id: "a", edge }]),
    graphNeighbors: vi.fn(async () => [{ node: { id: "b" }, edge }]),
    graphShortestPath: vi.fn(async () => [{ nodes: [{ id: "a" }, { id: "b" }], edges: [edge] }]),
    recallSearch: vi.fn(async () => [{ id: "recall-1", content: "remember this", source: { kind: "task" } }]),
    recallAppend: vi.fn(async () => [{ id: "recall-2", content: "saved", source: { kind: "task" } }]),
  };
}

async function runTransport(
  lines: string[],
  budgetProvider = vi.fn(async () => ({ settings: { agentToolOutputMaxChars: 300 } })),
  backendOverrides: Partial<ReturnType<typeof createBackends>> = {},
) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += String(chunk); });
  const backends = { ...createBackends(), ...backendOverrides };
  const loop = runMemoryMcpServerLoop({ input, output, projectRoot: "/fixture", backends, budgetProvider });
  for (const line of lines) input.write(line);
  input.end();
  await loop;
  return { responses: text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), backends, budgetProvider };
}

/**
 * FNXC:MemoryMcpTransport 2026-08-10-21:15:
 * The public MCP boundary is newline-delimited JSON-RPC, so every declared tool
 * must cross the real stream framing layer rather than only exercising the handler.
 */
describe("memory MCP JSON-RPC transport", () => {
  it("round-trips all five tools, preserves provenance, and frames partial/batched input", async () => {
    const calls = [
      ["graph_query", {}],
      ["graph_neighbors", { nodeId: "a" }],
      ["graph_shortest_path", { fromId: "a", toId: "b" }],
      ["recall_search", { query: "remember" }],
      ["recall_append", { kind: "decision", content: "saved", source: { kind: "task", id: "T-1" } }],
    ] as const;
    const requests = calls.map(([name, argumentsValue], index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name, arguments: argumentsValue } }));
    const { responses, backends, budgetProvider } = await runTransport([
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
      `${requests[0]!.slice(0, 28)}`,
      `${requests[0]!.slice(28)}\n${requests.slice(1).join("\n")}\n`,
    ]);

    expect(responses).toHaveLength(5);
    for (const response of responses) expect(response.result).toEqual({ content: [{ type: "text", text: expect.any(String) }] });
    expect(JSON.parse(responses[0]!.result.content[0].text).results[0].edge.provenance).toBe("inferred");
    expect(JSON.parse(responses[1]!.result.content[0].text).results[0].edge.provenance).toBe("inferred");
    expect(JSON.parse(responses[2]!.result.content[0].text).results[0].edges[0].provenance).toBe("inferred");
    expect(backends.graphQuery).toHaveBeenCalledOnce();
    expect(backends.graphNeighbors).toHaveBeenCalledOnce();
    expect(backends.graphShortestPath).toHaveBeenCalledOnce();
    expect(backends.recallSearch).toHaveBeenCalledOnce();
    expect(backends.recallAppend).toHaveBeenCalledOnce();
    expect(budgetProvider).toHaveBeenCalledOnce();
  });

  it("uses a finite fallback budget while unavailable recall storage returns an actionable error", async () => {
    const provider = vi.fn(async () => null);
    const { responses } = await runTransport([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_query", arguments: {} } })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recall_search", arguments: { query: "x" } } })}\n`,
    ], provider, { recallSearch: vi.fn(async () => { throw new Error("store unavailable SECRET_RECALL_CONTENT"); }) });
    expect(responses[0]!.result).not.toMatchObject({ isError: true });
    expect(responses[0]!.result.content[0].text.length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_MAX_CHARS);
    expect(responses[1]!.result).toMatchObject({ isError: true });
    expect(responses[1]!.result.content[0].text).toContain("Recall store is unavailable");
    expect(responses[1]!.result.content[0].text).not.toContain("SECRET_RECALL_CONTENT");
    expect(responses[1]!.result.content[0].text.length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_MAX_CHARS);
    expect(provider).toHaveBeenCalledOnce();
  });
});
