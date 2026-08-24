import { describe, expect, it } from "vitest";
import { CallToolResultSchema, ListToolsResultSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MemoryMcpHandler } from "../../../core/src/memory/mcp/index.js";
import type { ResolvedMcpServerDefinition } from "@fusion/core";
import { connectMcpSessionTools } from "../mcp/mcp-session-tools.js";

const memoryServer: ResolvedMcpServerDefinition = {
  name: "fusion-memory",
  transport: "stdio",
  command: "fusion-memory-test",
};

function createHandler(): MemoryMcpHandler {
  return new MemoryMcpHandler({
    graphQuery: async () => [{ id: "module:memory", type: "module" }],
    graphNeighbors: async () => [],
    graphShortestPath: async () => [],
    recallSearch: async () => { throw new Error("Recall store is unavailable"); },
    recallAppend: async () => [],
  });
}

class MemoryHandlerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  constructor(
    private readonly handler: MemoryMcpHandler,
    private readonly omitServerVersion = false,
  ) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    const response = await this.handler.handle(message);
    if (!response) return;
    const normalized = this.omitServerVersion && message.method === "initialize"
      ? {
          ...response,
          result: {
            ...(response.result as Record<string, unknown>),
            serverInfo: { name: "fusion-memory" },
          },
        }
      : response;
    this.onmessage?.(normalized as JSONRPCMessage);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

async function handlerResult(handler: MemoryMcpHandler, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await handler.handle(request);
  expect(response?.result).toBeDefined();
  return response!.result as Record<string, unknown>;
}

describe("fusion-memory MCP SDK handshake", () => {
  it("connects through the real SDK client and registers all memory tools", async () => {
    const toolset = await connectMcpSessionTools([memoryServer], {
      retryDelayMs: 0,
      transportFactory: () => new MemoryHandlerTransport(createHandler()),
    });

    try {
      expect(toolset.connected).toEqual(["fusion-memory"]);
      expect(toolset.skipped).toEqual([]);
      expect(toolset.tools.map(tool => tool.name)).toHaveLength(5);
      expect(toolset.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        "mcp__fusion-memory__graph_query",
        "mcp__fusion-memory__graph_neighbors",
        "mcp__fusion-memory__graph_shortest_path",
        "mcp__fusion-memory__recall_search",
        "mcp__fusion-memory__recall_append",
      ]));
    } finally {
      await toolset.dispose();
    }
  });

  it("still skips the original malformed initialize response with a ZodError", async () => {
    const toolset = await connectMcpSessionTools([memoryServer], {
      retryDelayMs: 0,
      transportFactory: () => new MemoryHandlerTransport(createHandler(), true),
    });

    try {
      expect(toolset.connected).toEqual([]);
      expect(toolset.skipped).toEqual([{ name: "fusion-memory", reason: "$ZodError" }]);
    } finally {
      await toolset.dispose();
    }
  });

  it("emits SDK-valid tool-list, success, and tool-error envelopes", async () => {
    const handler = createHandler();
    const listed = await handlerResult(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(ListToolsResultSchema.parse(listed).tools).toHaveLength(5);

    const graphQuery = await handlerResult(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "graph_query", arguments: {} },
    });
    expect(CallToolResultSchema.parse(graphQuery).isError).not.toBe(true);

    const recallFailure = await handlerResult(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "recall_search", arguments: { query: "memory" } },
    });
    expect(CallToolResultSchema.parse(recallFailure)).toMatchObject({ isError: true });
  });
});
