import "./executor-test-helpers.js";
import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TaskExecutor } from "../executor.js";
import { connectMcpSessionTools, type McpSessionClient } from "../mcp-session-tools.js";

function createStore(options: { secretFailure?: boolean } = {}) {
  const revealSecret = vi.fn(async () => {
    if (options.secretFailure) throw new Error("credential-bearing detail must not escape");
    return { key: "postiz-token", plaintextValue: "in-memory-only" };
  });
  return {
    on: vi.fn(),
    off: vi.fn(),
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => []),
    getSettingsByScope: vi.fn(async () => ({
      global: { mcpServers: { enabled: true, servers: [] } },
      project: {
        mcpServers: {
          enabled: true,
          servers: [{
            name: "postiz",
            transport: "streamable-http",
            url: "https://redacted.invalid/mcp",
            headers: { Authorization: { secretRef: "postiz-token", scope: "project" } },
          }],
        },
      },
    })),
    getSecretsStore: vi.fn(async () => ({ revealSecret })),
  } as any;
}

function fakeClient(close: ReturnType<typeof vi.fn>): McpSessionClient {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [{ name: "integrationlist", inputSchema: { type: "object" } }] })),
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }] })),
    close,
  };
}

const transportFactory = () => ({}) as Transport;

describe("executor project MCP bootstrap and approval resume invariant", () => {
  it("re-resolves one effective project server for every independent executor identity and fresh toolset", async () => {
    const store = createStore();
    const executor = new TaskExecutor(store, "/tmp/project");
    const identities = [undefined, "agent-main-004", "agent-main-005"];
    const closes: Array<ReturnType<typeof vi.fn>> = [];

    for (const agentId of identities) {
      const servers = await (executor as any).resolveMcpServers(agentId);
      const close = vi.fn(async () => undefined);
      closes.push(close);
      const toolset = await connectMcpSessionTools(servers, {
        clientFactory: () => fakeClient(close),
        transportFactory,
      });
      expect(toolset.tools.map((tool) => tool.name)).toEqual(["mcp__postiz__integrationlist"]);
      await toolset.dispose();
    }

    expect(store.getSettingsByScope).toHaveBeenCalledTimes(3);
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  });

  it("fails executor bootstrap with a sanitized outcome when secret materialization fails", async () => {
    const executor = new TaskExecutor(createStore({ secretFailure: true }), "/tmp/project");

    await expect((executor as any).resolveMcpServers("agent-main-007")).rejects.toThrow(
      /^MCP resolution failed: server=postiz reason=secret-materialization$/,
    );
  });

  it("closes a client whose connection fails before registration", async () => {
    const close = vi.fn(async () => undefined);
    const client = fakeClient(close);
    client.connect = vi.fn(async () => {
      throw new TypeError("credential-bearing detail must not escape");
    });

    const toolset = await connectMcpSessionTools(
      [{ name: "postiz", transport: "stdio", command: "fake" }],
      { clientFactory: () => client, transportFactory },
    );

    expect(toolset.skipped).toEqual([{ name: "postiz", reason: "TypeError" }]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
