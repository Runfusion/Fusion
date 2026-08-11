import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpSecretReader, TaskStore } from "@fusion/core";
import { buildFusionMemoryBuiltIns } from "@fusion/core/mcp-builtin-servers";
import {
  resolveMcpExportEffectiveServers,
  resolveMcpListEffectiveServers,
  resolveMcpValidateEffectiveServers,
} from "../../../cli/src/commands/mcp.js";
import { resolveMcpServersForMcpProbe } from "../../../dashboard/src/routes/register-config-mcp-pi-settings-routes.js";
import { resolveMcpServers } from "../executor/resolve-mcp-servers.js";
import { resolveHeartbeatMcpForAgent } from "../agent-heartbeat.js";
import { resolveMcpServersForRuntime, resolveMcpServersForStore, type McpSettingsAndSecretsStore } from "../mcp/mcp-resolution.js";

const repoRoot = resolve(process.cwd(), "../..");
const roots = ["packages/engine/src", "packages/dashboard/src", "packages/dashboard/app", "packages/cli/src", "packages/core/src"];
const needles = ["resolveMcpServersForStore(", "resolveMcpServersForRuntime(", "resolveEffectiveMcpServers("] as const;
const fixtureEntry = resolve(repoRoot, "package.json");
type Bucket = "A" | "B" | "C" | "D" | "R";
type LedgerRow = { file: string; line: number; bucket: Bucket; expression: string; type?: "TaskStore" | "nullable-root"; reason: string; passesBuiltIns?: true | "descriptor-only" };

/*
 * FNXC:MemoryMcpCoverage 2026-08-11-00:05:
 * This is intentionally a per-call-site ledger, not a file/count inventory. A resolver forwarding
 * scan cannot prove a lane passes a root-capable store, so each A row names its real expression and
 * type while D records direct callers that would otherwise bypass the runtime resolver.
 */
const LEDGER: LedgerRow[] = [
  ["packages/engine/src/executor/resolve-mcp-servers.ts",32,"A","deps.store","TaskStore","executor TaskStore"],
  ["packages/engine/src/execution/reviewer.ts",543,"A","options.store","TaskStore","reviewer TaskStore"],
  ["packages/engine/src/merger.ts",362,"A","store","TaskStore","merger TaskStore"],
  ["packages/engine/src/merge/merger-ai.ts",469,"A","store","TaskStore","merger AI TaskStore"],
  ["packages/engine/src/merge/merger-ai.ts",542,"A","store","TaskStore","merger AI TaskStore"],
  ["packages/engine/src/merge/pr-response-run-ops.ts",112,"A","store","TaskStore","PR response TaskStore"],
  ["packages/engine/src/agent-heartbeat.ts",177,"A","taskStore","nullable-root","heartbeat accepts a nullable root"],
  ["packages/engine/src/triage.ts",3136,"A","this.store","TaskStore","triage TaskStore"],
  ["packages/engine/src/scheduling/cron-runner.ts",1073,"A","store","TaskStore","cron TaskStore"],
  ["packages/engine/src/missions/mission-execution-loop.ts",965,"A","this.taskStore","TaskStore","mission TaskStore"],
  ["packages/engine/src/agents/agent-reflection.ts",157,"A","this.taskStore","TaskStore","reflection TaskStore"],
  ["packages/engine/src/eval/evaluator.ts",170,"A","this.deps.store","TaskStore","evaluator TaskStore"],
  ["packages/dashboard/src/chat.ts",2871,"A","this.taskStore","TaskStore","chat scoped TaskStore"],
  ["packages/dashboard/src/planning.ts",128,"A","store","TaskStore","planning TaskStore"],
  ["packages/dashboard/src/milestone-slice-interview.ts",826,"A","store","TaskStore","milestone TaskStore"],
  ["packages/dashboard/src/mission-interview.ts",938,"A","store","TaskStore","mission interview TaskStore"],
  ["packages/dashboard/src/subtask-breakdown.ts",410,"A","store ?? {}","TaskStore","optional store resolves as TaskStore when present"],
  ["packages/dashboard/src/subtask-breakdown.ts",545,"A","store ?? {}","TaskStore","optional store resolves as TaskStore when present"],
  ["packages/dashboard/src/agent-generation.ts",504,"A","store ?? {}","TaskStore","optional store resolves as TaskStore when present"],
  ["packages/dashboard/src/pr-conflict-resolver.ts",182,"A","store","TaskStore","conflict resolver TaskStore"],
  ["packages/dashboard/src/routes/automation-step-execution.ts",181,"A","taskStore","TaskStore","automation TaskStore"],
  ["packages/dashboard/src/ai-refine.ts",340,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/ai-refine.ts",422,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/ai-translate.ts",342,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/agent-onboarding.ts",358,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/pr-metadata-generator.ts",302,"B","store ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/dashboard/src/insights-routes.ts",187,"B","params.taskStore ?? {}",undefined,"pre-existing no-store degrade"],
  ["packages/engine/src/agent-heartbeat.ts",177,"C","taskStore","nullable-root","undefined or empty root omits only built-in"],
  ["packages/cli/src/commands/mcp.ts",136,"D","builtIns",undefined,"CLI list direct resolver",true],
  ["packages/cli/src/commands/mcp.ts",140,"D","builtIns",undefined,"CLI export direct resolver",true],
  ["packages/cli/src/commands/mcp.ts",144,"D","builtIns",undefined,"CLI validate direct resolver",true],
  ["packages/dashboard/app/components/settings/sections/McpServersCard.tsx",354,"D","descriptor display",undefined,"browser has no spawn entry","descriptor-only"],
  ["packages/engine/src/mcp/mcp-resolution.ts",38,"D","runtime resolver",undefined,"runtime entrypoint",true],
  ["packages/engine/src/mcp/mcp-resolution.ts",41,"D","built-in factory",undefined,"runtime calls effective resolver",true],
  ["packages/engine/src/mcp/mcp-resolution.ts",76,"D","store resolver",undefined,"store entrypoint",true],
  ["packages/engine/src/mcp/mcp-resolution.ts",94,"D","projectRoot",undefined,"store forwards root",true],
  ["packages/core/src/config/mcp-config.ts",93,"D","effective resolver",undefined,"resolution chokepoint",true],
  ["packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts",84,"R","explicit projectRoot",undefined,"server probe root"],
  ["packages/dashboard/src/routes/register-config-mcp-pi-settings-routes.ts",106,"R","scopedStore",undefined,"server settings root"],
].map(([file, line, bucket, expression, type, reason, passesBuiltIns]) => ({ file, line, bucket, expression, type, reason, passesBuiltIns }));

const secretReader: McpSecretReader = { revealSecret: async () => { throw new Error("unexpected secret"); } };
const rootStore = {
  async getSettingsByScope() { return { global: { mcpServers: { enabled: true } }, project: { mcpServers: { enabled: true } } }; },
  getSecretsStore: async () => secretReader,
  getRootDir: () => "/fixture",
};

type NullableRootStore = Omit<McpSettingsAndSecretsStore, "getRootDir"> & { getRootDir(): string | undefined };
const taskStoreWitness = null as unknown as TaskStore satisfies McpSettingsAndSecretsStore;
const nullableRootWitness = null as unknown as NullableRootStore satisfies McpSettingsAndSecretsStore;
void taskStoreWitness;
void nullableRootWitness;

function sourceCalls(): Array<{ file: string; line: number }> {
  const found: Array<{ file: string; line: number }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "__tests__" && entry.name !== "mocks") walk(full); continue; }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      for (const [index, line] of readFileSync(full, "utf8").split("\n").entries()) if (needles.some((needle) => line.includes(needle))) found.push({ file: full.slice(repoRoot.length + 1), line: index + 1 });
    }
  };
  for (const root of roots) walk(resolve(repoRoot, root));
  return found;
}

function hasMemoryServer(result: { servers: Array<{ name: string; args?: string[] }> }) {
  expect(result.servers).toContainEqual(expect.objectContaining({ name: "fusion-memory", args: expect.arrayContaining([fixtureEntry]) }));
}

describe("fusion-memory MCP lane ledger", () => {
  const priorEntry = process.env.FUSION_MEMORY_MCP_ENTRY;
  afterEach(() => {
    if (priorEntry === undefined) delete process.env.FUSION_MEMORY_MCP_ENTRY;
    else process.env.FUSION_MEMORY_MCP_ENTRY = priorEntry;
  });

  it("maps every resolver call across all roots to one required bucket", () => {
    const calls = sourceCalls();
    const mappedCalls = [...new Map(LEDGER.map(({ file, line }) => [`${file}:${line}`, { file, line }])).values()];
    expect(calls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)).toEqual(
      mappedCalls.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    );
    expect(LEDGER.filter((row) => row.bucket === "A").map((row) => row.file)).toEqual(expect.arrayContaining([
      expect.stringContaining("executor"), expect.stringContaining("reviewer"), expect.stringContaining("merger"), expect.stringContaining("triage"), expect.stringContaining("agent-heartbeat"), expect.stringContaining("chat"), expect.stringContaining("planning"),
    ]));
    expect(LEDGER.filter((row) => row.bucket === "D" && row.passesBuiltIns === true).filter((row) => row.file === "packages/cli/src/commands/mcp.ts")).toHaveLength(3);
    const cli = readFileSync(resolve(repoRoot, "packages/cli/src/commands/mcp.ts"), "utf8");
    for (const row of LEDGER.filter((entry) => entry.file === "packages/cli/src/commands/mcp.ts")) expect(cli.split("\n")[row.line - 1]).toContain("builtIns");
  });

  it("proves bucket behavior with an injected entry and no ambient build dependency", async () => {
    const enabled = { mcpServers: { enabled: true, servers: [{ name: "other", transport: "stdio" as const, command: "other" }] } };
    hasMemoryServer(await resolveMcpServersForRuntime({ globalSettings: enabled, projectSettings: null, secrets: secretReader, projectRoot: "/fixture", memoryMcpEntry: fixtureEntry }));
    await expect(resolveMcpServersForStore({})).resolves.toEqual({ servers: [], errors: [] });
    for (const root of [undefined, ""]) {
      const result = await resolveMcpServersForRuntime({ globalSettings: enabled, projectSettings: null, secrets: secretReader, projectRoot: root, memoryMcpEntry: fixtureEntry });
      expect(result.servers.map((server) => server.name)).toEqual(["other"]);
    }
    const missing = await resolveMcpServersForRuntime({ globalSettings: enabled, projectSettings: null, secrets: secretReader, projectRoot: "/fixture", memoryMcpEntry: null });
    expect(missing.servers.map((server) => server.name)).toEqual(["other"]);
  });

  it("drives every CLI direct resolver and the explicit-root probe with an injected entry", async () => {
    const global = { enabled: true, servers: [{ name: "other", transport: "stdio" as const, command: "other" }] };
    const builtIns = buildFusionMemoryBuiltIns("/fixture", fixtureEntry);
    const directResolvers = [resolveMcpListEffectiveServers, resolveMcpExportEffectiveServers, resolveMcpValidateEffectiveServers];
    for (const resolveDirect of directResolvers) {
      hasMemoryServer({ servers: resolveDirect(global, undefined, builtIns) });
    }

    const probe = await resolveMcpServersForMcpProbe({
      globalSettings: { mcpServers: global },
      projectSettings: null,
      secrets: secretReader,
      projectRoot: "/fixture",
      memoryMcpEntry: fixtureEntry,
    });
    hasMemoryServer(probe);
  });

  it("drives executor and heartbeat wrappers with a root and validates heartbeat degradation", async () => {
    process.env.FUSION_MEMORY_MCP_ENTRY = fixtureEntry;
    const store = rootStore as unknown as TaskStore;
    const executor = await resolveMcpServers({ store });
    expect(executor).toContainEqual(expect.objectContaining({ name: "fusion-memory" }));
    const heartbeat = await resolveHeartbeatMcpForAgent(store, "agent");
    expect(heartbeat.servers).toContainEqual(expect.objectContaining({ name: "fusion-memory" }));
    const noRoot = { ...rootStore, getRootDir: () => undefined } as unknown as TaskStore;
    await expect(resolveHeartbeatMcpForAgent(noRoot, "agent")).resolves.toMatchObject({ servers: [] });
  });
});
