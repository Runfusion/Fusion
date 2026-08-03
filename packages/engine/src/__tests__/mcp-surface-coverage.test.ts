import { readdirSync, readFileSync } from "node:fs";
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

  it("keeps every executor-owned fresh-session seam on immediate MCP re-resolution", () => {
    /*
    FNXC:CodeOrganization 2026-08-03-16:25 (U4 runImplementation peel):
    Fresh-session MCP re-resolution call sites moved into free peels
    (`mcpServers: await deps.resolveMcpServers(...)`) under executor/*. Scan the
    whole executor/ tree so U4 peels cannot drop a create-session MCP seam silently.
    */
    const executorDir = join(process.cwd(), "src/executor");
    const peelSources = readdirSync(executorDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
      .map((name) => readFileSync(join(executorDir, name), "utf8"));
    const monolith = readFileSync(join(process.cwd(), "src/executor.ts"), "utf8");
    const source = [monolith, ...peelSources].join("\n");
    const immediateResolutions = source.match(/mcpServers:\s*await\s+(?:this|deps)\.resolveMcpServers\(/g) ?? [];

    // Main executor, fresh retry, workflow/manual model seams, self-fix/review,
    // and spawned-child paths all resolve at their own create-session call.
    expect(immediateResolutions.length).toBeGreaterThanOrEqual(6);
    expect(source).toContain("resumeApprovalAfterUnwindIfNeeded");
    expect(source).toContain("approvalResumeAfterUnwind");
  });

  it("keeps the heartbeat createResolvedAgentSession seam wired to the resolved MCP result", () => {
    expectResolvedMcpForwarded(
      "src/agent-heartbeat.ts",
      "const heartbeatMcp = await resolveHeartbeatMcpForAgent(taskStore, agentId);",
      // FNXC:McpCoverage 2026-08-02-00:15: FN-8654 rebound `session` to a `let` so credential-instance rotation can reassign it; match the destructuring seam without pinning the declaration keyword so the const/let refactor no longer breaks this wiring check.
      "{ session } = await createResolvedAgentSession({",
      "mcpServers: heartbeatMcp.servers",
    );
  });

  it("keeps the PR response merger seam wired to resolved MCP", () => {
    /*
    FNXC:CodeOrganization 2026-08-03-16:25:
    pr-response-run-ops lives under merge/, not the engine package root.
    */
    expectResolvedMcpForwarded(
      "src/merge/pr-response-run-ops.ts",
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
    /*
    FNXC:EngineTests 2026-07-20-23:55:
    Manual AI-prompt MCP resolution lives in automation-step-execution after the routes split.
    */
    expectResolvedMcpForwarded(
      "../dashboard/src/routes/automation-step-execution.ts",
      "const mcpServers = await resolveManualAiPromptMcpServers(taskStore);",
      "const { session } = await createFnAgent({",
      "mcpServers,",
    );
  });

  it("keeps dashboard planning forwarding resolved MCP with the readonly opt-in", () => {
    const source = readFileSync(join(process.cwd(), "../dashboard/src/planning.ts"), "utf8");
    // FNXC:McpCoverage 2026-07-07-09:50: FN-7446 wrapped planning MCP resolution in resolvePlanningMcpServers(store), defaulting undefined resolver results to empty servers. Match the new helper call instead of the raw (await resolveMcpServersForStore(store)).servers expression.
    const forwardingNeedle = "mcpServers: await resolvePlanningMcpServers(store),";
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
