import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedMcpServerDefinition } from "@fusion/core";
import { connectMcpSessionTools, uniqueMcpToolName, type McpSessionClient } from "../mcp/mcp-session-tools.js";

function stdioServer(name: string, enabled = true): ResolvedMcpServerDefinition {
  return { name, transport: "stdio", command: "fake", enabled };
}

function fakeClient(toolNames: string[], calls: string[] = []): McpSessionClient {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({
      tools: toolNames.map((name) => ({
        name,
        description: `tool ${name}`,
        inputSchema: name === "lookup"
          ? {
              type: "object",
              properties: { topic: { type: "string", description: "Topic to look up" } },
              required: ["topic"],
            }
          : undefined,
      })),
    })),
    callTool: vi.fn(async ({ name, arguments: args }) => {
      calls.push(name);
      if (name === "fail") return { content: [{ type: "text", text: "failed" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] };
    }),
    close: vi.fn(async () => undefined),
  };
}

const transportFactory = () => ({}) as Transport;

describe("connectMcpSessionTools", () => {
  it("registers namespaced tools and routes calls to the owning MCP client", async () => {
    const calls: string[] = [];
    const client = fakeClient(["lookup"], calls);
    const toolset = await connectMcpSessionTools([stdioServer("context7")], {
      clientFactory: () => client,
      transportFactory,
    });

    expect(toolset.connected).toEqual(["context7"]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual(["mcp__context7__lookup"]);
    expect(client.connect).toHaveBeenCalledWith(expect.anything(), { timeout: 15_000 });
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 15_000 });
    expect(toolset.tools[0]!.parameters).toMatchObject({
      type: "object",
      properties: { topic: { type: "string", description: "Topic to look up" } },
      required: ["topic"],
    });
    const result = await toolset.tools[0]!.execute("call", { topic: "mcp" } as never, undefined, undefined, {} as never);
    expect(calls).toEqual(["lookup"]);
    expect(result.content[0].text).toContain("mcp");
    await toolset.dispose();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("maps tool errors without throwing", async () => {
    const toolset = await connectMcpSessionTools([stdioServer("srv")], {
      clientFactory: () => fakeClient(["fail"]),
      transportFactory,
    });

    const result = await toolset.tools[0]!.execute("call", {}, undefined, undefined, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("failed");
  });

  it("skips disabled and failed servers while keeping reachable tools", async () => {
    const good = fakeClient(["read"]);
    const bad: McpSessionClient = {
      ...fakeClient([]),
      connect: vi.fn(async () => { throw new Error("offline"); }),
    };
    const toolset = await connectMcpSessionTools([stdioServer("disabled", false), stdioServer("bad"), stdioServer("good")], {
      clientFactory: (server) => server.name === "bad" ? bad : good,
      transportFactory,
      maxAttempts: 1,
    });

    expect(toolset.skipped).toEqual([
      { name: "disabled", reason: "disabled" },
      { name: "bad", reason: "error" },
    ]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual(["mcp__good__read"]);
  });

  it("retries a failed server with fresh clients before exposing its tools", async () => {
    const clients = [
      { ...fakeClient([]), connect: vi.fn(async () => { throw new TypeError("offline"); }) },
      { ...fakeClient([]), connect: vi.fn(async () => { throw new TypeError("offline"); }) },
      fakeClient(["lookup"]),
    ];
    const clientFactory = vi.fn(() => clients.shift()!);
    const logger = { log: vi.fn(), warn: vi.fn() };

    const toolset = await connectMcpSessionTools([stdioServer("context7")], {
      clientFactory,
      transportFactory,
      retryDelayMs: 0,
      logger,
    });

    expect(clientFactory).toHaveBeenCalledTimes(3);
    expect(toolset.connected).toEqual(["context7"]);
    expect(toolset.skipped).toEqual([]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual(["mcp__context7__lookup"]);
    expect(logger.warn).toHaveBeenCalledWith("Retrying MCP server for pi session: name=context7 transport=stdio attempt=2/3 reason=TypeError");
    expect(logger.warn).toHaveBeenCalledWith("Retrying MCP server for pi session: name=context7 transport=stdio attempt=3/3 reason=TypeError");
  });

  it("records one skipped server after bounded retries are exhausted", async () => {
    const clients: McpSessionClient[] = [];
    const clientFactory = vi.fn(() => {
      const client: McpSessionClient = {
        ...fakeClient([]),
        connect: vi.fn(async () => { throw new RangeError("unavailable"); }),
      };
      clients.push(client);
      return client;
    });

    const toolset = await connectMcpSessionTools([stdioServer("context7")], {
      clientFactory,
      transportFactory,
      retryDelayMs: 0,
    });

    expect(clientFactory).toHaveBeenCalledTimes(3);
    expect(toolset.connected).toEqual([]);
    expect(toolset.skipped).toEqual([{ name: "context7", reason: "RangeError" }]);
    expect(clients).toHaveLength(3);
    for (const client of clients) expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when bootstrap is aborted", async () => {
    const controller = new AbortController();
    const client = {
      ...fakeClient([]),
      connect: vi.fn(async () => {
        controller.abort();
        throw new TypeError("offline");
      }),
    };
    const clientFactory = vi.fn(() => client);

    const toolset = await connectMcpSessionTools([stdioServer("context7")], {
      clientFactory,
      transportFactory,
      signal: controller.signal,
    });

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(toolset.skipped).toEqual([{ name: "context7", reason: "aborted" }]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("keeps empty tool-list connections and creates no tools", async () => {
    const toolset = await connectMcpSessionTools([stdioServer("empty")], {
      clientFactory: () => fakeClient([]),
      transportFactory,
    });

    expect(toolset.connected).toEqual(["empty"]);
    expect(toolset.tools).toEqual([]);
  });

  it("deduplicates sanitized server and tool name collisions deterministically", () => {
    const used = new Set<string>();
    expect(uniqueMcpToolName("a.b", "bash", used)).toBe("mcp__a_b__bash");
    expect(uniqueMcpToolName("a_b", "bash", used)).toBe("mcp__a_b__bash__2");
    expect(uniqueMcpToolName("a_b", "read", used)).toBe("mcp__a_b__read");
  });
});
