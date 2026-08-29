#!/usr/bin/env node
import { openBackend } from "./lib/backend-db.mjs";

function createSummary() {
  return { total_input: 0, total_cached: 0, total_cache_write: 0, total_output: 0, n_tasks: 0, hit_ratio: 0 };
}

function applyUsage(summary, usage) {
  summary.total_input += usage.inputTokens ?? 0;
  summary.total_cached += usage.cachedTokens ?? 0;
  summary.total_cache_write += usage.cacheWriteTokens ?? 0;
  summary.total_output += usage.outputTokens ?? 0;
  summary.n_tasks += 1;
}

function finalizeSummary(summary) {
  const denominator = summary.total_input + summary.total_cached;
  return { ...summary, hit_ratio: denominator > 0 ? summary.total_cached / denominator : 0 };
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.table(rows);
}

export async function collectCacheStats({ taskStore, agentStore, isEphemeralAgent = () => false }) {
  const tasks = await taskStore.listTasks({ includeArchived: true, slim: true });
  const agents = await agentStore.listAgents({ includeEphemeral: true });
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  const roleSummaries = new Map();
  const agentSummaries = new Map();

  for (const task of tasks) {
    if (!task.tokenUsage) continue;
    const ownerId = task.assignedAgentId ?? task.sourceAgentId ?? task.checkedOutBy;
    const owner = ownerId ? agentById.get(ownerId) : undefined;
    const role = owner?.role ?? "unknown";

    if (!roleSummaries.has(role)) roleSummaries.set(role, createSummary());
    applyUsage(roleSummaries.get(role), task.tokenUsage);

    if (owner && !isEphemeralAgent(owner)) {
      if (!agentSummaries.has(owner.id)) agentSummaries.set(owner.id, { id: owner.id, role: owner.role, ...createSummary() });
      applyUsage(agentSummaries.get(owner.id), task.tokenUsage);
    }
  }

  const byRole = Array.from(roleSummaries.entries()).map(([role, summary]) => ({ role, ...finalizeSummary(summary) }));
  const byAgent = Array.from(agentSummaries.values()).map((summary) => ({ ...summary, ...finalizeSummary(summary) }));
  return { byRole, byAgent };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const asJson = argv.includes("--json");
  const projectDir = process.cwd();

  let backend;
  try {
    const { taskStore, agentStore, isEphemeralAgent } = deps.stores ?? (await (async () => {
      backend = await openBackend(projectDir);
      const { AgentStore, isEphemeralAgent } = backend.core;
      const aStore = new AgentStore({
        rootDir: backend.store.getFusionDir(),
        taskStore: backend.store,
        asyncLayer: backend.asyncLayer,
      });
      await aStore.init();
      return { taskStore: backend.store, agentStore: aStore, isEphemeralAgent };
    })());

    /* FNXC:PostgresOperationalScripts 2026-07-14-18:18: Operator reports must read the authoritative PostgreSQL store and release embedded backend ownership after collection. */
    const result = await collectCacheStats({ taskStore, agentStore, isEphemeralAgent });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    printTable("Cache stats by role", result.byRole);
    printTable("Cache stats by permanent agent", result.byAgent);
    return 0;
  } finally {
    await backend?.shutdown();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
