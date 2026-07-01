import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpSecretReader } from "@fusion/core";
import { resolveHeartbeatMcpForAgent } from "../agent-heartbeat.js";

function secrets(values: Record<string, string>): McpSecretReader {
  return {
    async revealSecret(id, _scope, reader) {
      expect(reader?.agentId).toBe("agent-heartbeat-1");
      const plaintextValue = values[id];
      if (plaintextValue === undefined) throw new Error(`missing ${id}`);
      return { key: id, plaintextValue };
    },
  };
}

function expectResolvedMcpForwarded(
  sourcePath: string,
  resolveNeedle: string,
  createNeedle: string,
  forwardNeedle: string,
  afterForwardNeedle?: string,
) {
  const source = readFileSync(join(process.cwd(), sourcePath), "utf8");
  const resolveIndex = source.indexOf(resolveNeedle);
  const createIndex = source.indexOf(createNeedle, resolveIndex);
  const forwardIndex = source.indexOf(forwardNeedle, createIndex);
  const afterForwardIndex = afterForwardNeedle ? source.indexOf(afterForwardNeedle, forwardIndex) : -1;

  expect(resolveIndex).toBeGreaterThan(-1);
  expect(createIndex).toBeGreaterThan(resolveIndex);
  expect(forwardIndex).toBeGreaterThan(createIndex);
  if (afterForwardNeedle) expect(afterForwardIndex).toBeGreaterThan(forwardIndex);
}

describe("MCP surface coverage", () => {
  it("resolves heartbeat MCP with the agent identity and materialized secrets", async () => {
    const result = await resolveHeartbeatMcpForAgent({
      async getSettingsByScope() {
        return {
          global: { mcpServers: { enabled: true, servers: [] } },
          project: {
            mcpServers: {
              enabled: true,
              servers: [
                {
                  name: "heartbeat-tools",
                  transport: "stdio",
                  command: "node",
                  args: ["server.js"],
                  env: { MCP_TOKEN: { secretRef: "heartbeat-token", scope: "project" } },
                },
              ],
            },
          },
        };
      },
      async getSecretsStore() {
        return secrets({ "heartbeat-token": "materialized-heartbeat-secret" });
      },
    }, "agent-heartbeat-1");

    expect(result.errors).toEqual([]);
    expect(result.servers).toEqual([
      {
        name: "heartbeat-tools",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { MCP_TOKEN: "materialized-heartbeat-secret" },
      },
    ]);
  });

  it("returns empty MCP for heartbeat when settings disable servers", async () => {
    const result = await resolveHeartbeatMcpForAgent({
      async getSettingsByScope() {
        return {
          global: { mcpServers: { enabled: true, servers: [{ name: "disabled", transport: "stdio", command: "node" }] } },
          project: { mcpServers: { enabled: false, servers: [] } },
        };
      },
      async getSecretsStore() {
        return secrets({});
      },
    }, "agent-heartbeat-1");

    expect(result).toEqual({ servers: [], errors: [] });
  });

  it("keeps heartbeat session creation working when no store is available", async () => {
    await expect(resolveHeartbeatMcpForAgent(undefined, "agent-heartbeat-1")).resolves.toEqual({ servers: [], errors: [] });
  });

  it("keeps the heartbeat createResolvedAgentSession seam wired to the resolved MCP result", () => {
    expectResolvedMcpForwarded(
      "src/agent-heartbeat.ts",
      "const heartbeatMcp = await resolveHeartbeatMcpForAgent(taskStore, agentId);",
      "const { session } = await createResolvedAgentSession({",
      "mcpServers: heartbeatMcp.servers",
    );
  });

  it("keeps the PR response merger seam wired to resolved MCP", () => {
    expectResolvedMcpForwarded(
      "src/pr-response-run-ops.ts",
      "const mcpServers = store ? (await resolveMcpServersForStore(store)).servers : undefined;",
      "const { session } = await createResolvedAgentSession({",
      "mcpServers,",
    );
  });

  it("keeps the dashboard PR conflict resolver merger seam wired to resolved MCP", () => {
    expectResolvedMcpForwarded(
      "../dashboard/src/pr-conflict-resolver.ts",
      "const mcpServers = (await resolveMcpServersForStore(store)).servers;",
      "const { session } = await createResolvedAgentSession({",
      "mcpServers,",
    );
  });

  it("keeps the manual AI-prompt workflow step forwarding resolved MCP", () => {
    expectResolvedMcpForwarded(
      "../dashboard/src/routes.ts",
      "const mcpServers = await resolveManualAiPromptMcpServers(taskStore);",
      "const { session } = await createFnAgent({",
      "mcpServers,",
    );
  });

  it("keeps dashboard planning forwarding resolved MCP with the readonly opt-in", () => {
    const source = readFileSync(join(process.cwd(), "../dashboard/src/planning.ts"), "utf8");
    const forwardingNeedle = "mcpServers: (await resolveMcpServersForStore(store)).servers,";
    expect(source.match(new RegExp(forwardingNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(2);
    expect(source.match(/allowMcpToolsInReadonly: true,/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("const agentResult = await createFnAgent({");
    expect(source).toContain("return createFnAgent({");
  });

  it("keeps mission interview forwarding the store-resolved MCP result with the readonly opt-in", () => {
    expectResolvedMcpForwarded(
      "../dashboard/src/mission-interview.ts",
      "const mcpServers = (await resolveMcpServersForStore(store)).servers;",
      "return createFnAgent({",
      "mcpServers,",
      "allowMcpToolsInReadonly: true,",
    );
  });

  it("keeps milestone and slice interview forwarding the store-resolved MCP result with the readonly opt-in", () => {
    expectResolvedMcpForwarded(
      "../dashboard/src/milestone-slice-interview.ts",
      "const mcpServers = (await resolveMcpServersForStore(store)).servers;",
      "return createFnAgent({",
      "mcpServers,",
      "allowMcpToolsInReadonly: true,",
    );
  });
});
