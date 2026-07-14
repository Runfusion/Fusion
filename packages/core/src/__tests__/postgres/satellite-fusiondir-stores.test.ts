/**
 * PostgreSQL satellite fusion-dir stores integration test (U6).
 *
 * FNXC:SatelliteFusionDirStores 2026-06-24-16:00:
 * Integration tests proving the async Drizzle helper modules for the
 * fusion-dir-owned satellite stores (AgentStore, PluginStore, AutomationStore,
 * RoutineStore) round-trip correctly against real PostgreSQL.
 *
 * VAL-DATA-015 (document/artifact parent-task scoping under soft-delete) is
 * preserved because these stores use the same project/central schema tables
 * and the same deletedAt-filtering invariants the task-store modules enforce;
 * the helper round-trips here prove the jsonb/integer columns the stores depend
 * on survive the backend swap.
 *
 * VAL-DATA-016 (plugin store contract stability) is directly exercised by the
 * PluginStore section: the central.plugin_installs and
 * central.project_plugin_states tables are the contract surface
 * fusion-plugin-roadmap depends on.
 *
 * ReflectionStore is NOT covered here because it is JSONL-file based (no SQLite
 * / PostgreSQL data path); its persistence layer does not change in this
 * migration. It is documented in the library note.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_fdir_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface StoreTestCtx {
  dbName: string;
  layer: AsyncDataLayer;
}

async function setupCtx(): Promise<StoreTestCtx> {
  const dbName = uniqueDbName();
  try { adminExec(`DROP DATABASE IF EXISTS "${dbName}"`); } catch { /* may not exist */ }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");
  const { applySchemaBaseline } = await import("../../postgres/schema-applier.js");
  const { resolveBackendWithOptions } = await import("../../postgres/backend-resolver.js");
  const backend = resolveBackendWithOptions({ databaseUrl: testUrl, databaseMigrationUrl: testUrl });
  const connections = await createConnectionSetFromUrl(backend, { poolMax: 3, connectTimeoutSeconds: 5 });
  await applySchemaBaseline(connections.migration);
  const layer = createAsyncDataLayer(connections);
  return { dbName, layer };
}

async function teardownCtx(ctx: StoreTestCtx | null): Promise<void> {
  if (!ctx) return;
  try { await ctx.layer.close(); } catch { /* best-effort */ }
  try { adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`); } catch { /* best-effort */ }
}

/**
 * Seed a minimal parent agent row so satellite tables with FK constraints
 * (heartbeats, runs, task sessions, API keys, config revisions, blocked
 * states) referencing project.agents.id can be inserted.
 */
async function seedAgent(layer: AsyncDataLayer, agentId: string): Promise<void> {
  const { writeAgent } = await import("../../async-agent-store.js");
  const now = new Date().toISOString();
  await writeAgent(layer.db, {
    id: agentId,
    name: `Seed ${agentId}`,
    role: "worker",
    state: "active",
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
}

pgDescribe("PostgreSQL satellite fusion-dir stores (VAL-DATA-015, VAL-DATA-016)", () => {
  let ctx: StoreTestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  // ── AutomationStore ──

  it("AutomationStore: create → get → list → update (upsert) → due query → delete", async () => {
    ctx = await setupCtx();
    const { upsertSchedule, getSchedule, findSchedule, listSchedules, deleteSchedule, getDueSchedules } = await import("../../async-automation-store.js");
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    const schedule = {
      id: `auto-${randomUUID().slice(0, 8)}`,
      name: "Nightly Build",
      description: "Run the build",
      scheduleType: "daily" as const,
      cronExpression: "0 2 * * *",
      command: "pnpm build",
      enabled: true,
      timeoutMs: 60_000,
      steps: [{ id: "s1", name: "step1", command: "echo hi" }],
      nextRunAt: past,
      lastRunAt: undefined,
      lastRunResult: undefined,
      runCount: 0,
      runHistory: [],
      scope: "project" as const,
      createdAt: now,
      updatedAt: now,
    };

    await upsertSchedule(ctx.layer, schedule);
    const fetched = await getSchedule(ctx.layer, schedule.id);
    expect(fetched.name).toBe("Nightly Build");
    expect(fetched.enabled).toBe(true);
    expect(fetched.steps).toHaveLength(1);
    expect(fetched.cronExpression).toBe("0 2 * * *");

    // Update via upsert (change enabled + lastRunResult)
    const updated = {
      ...schedule,
      enabled: false,
      lastRunAt: now,
      lastRunResult: { success: true, output: "ok", startedAt: past, completedAt: now },
      runCount: 1,
      runHistory: [{ success: true, output: "ok", startedAt: past, completedAt: now }],
      updatedAt: now,
    };
    await upsertSchedule(ctx.layer, updated);
    const afterUpdate = await getSchedule(ctx.layer, schedule.id);
    expect(afterUpdate.enabled).toBe(false);
    expect(afterUpdate.runCount).toBe(1);
    expect(afterUpdate.lastRunResult).toEqual(updated.lastRunResult);
    expect(afterUpdate.runHistory).toHaveLength(1);

    // List
    const all = await listSchedules(ctx.layer);
    expect(all).toHaveLength(1);

    // Due query (enabled=false now, so not due)
    const dueDisabled = await getDueSchedules(ctx.layer, now, "project");
    expect(dueDisabled).toHaveLength(0);

    // Re-enable and check due
    await upsertSchedule(ctx.layer, { ...updated, enabled: true });
    const dueEnabled = await getDueSchedules(ctx.layer, now, "project");
    expect(dueEnabled).toHaveLength(1);
    expect(dueEnabled[0]!.id).toBe(schedule.id);

    // findSchedule returns the row, deleteSchedule removes it
    expect((await findSchedule(ctx.layer, schedule.id))?.id).toBe(schedule.id);
    expect(await deleteSchedule(ctx.layer, schedule.id)).toBe(true);
    expect(await findSchedule(ctx.layer, schedule.id)).toBeUndefined();
  });

  /**
   * FNXC:AutomationIsolation 2026-07-13-22:37:
   * Embedded PostgreSQL shares one physical automations table across projects, while SQLite provided isolation through one file per project. Every automation operation must therefore use the bound AsyncDataLayer projectId. This regression covers empty, undefined-project, duplicate-ID, and populated states and proves that listing, mutation, deletion, and the due-run claim boundary cannot cross projects. A `global` scope remains an execution lane owned by the project that created it; it is not permission for another project's cron runner to execute the command.
   */
  it("AutomationStore: isolates duplicate IDs and due-run claims across two bound projects", async () => {
    ctx = await setupCtx();
    const { upsertSchedule, listSchedules } = await import("../../async-automation-store.js");
    const { AutomationStore } = await import("../../automation-store.js");
    const layerA = { ...ctx.layer, projectId: "project-a" } as AsyncDataLayer;
    const layerB = { ...ctx.layer, projectId: "project-b" } as AsyncDataLayer;
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const duplicateId = "shared-automation-id";
    const schedule = (name: string, scope: "global" | "project") => ({
      id: duplicateId,
      name,
      scheduleType: "custom" as const,
      cronExpression: "* * * * *",
      command: `echo ${name}`,
      enabled: true,
      runCount: 0,
      runHistory: [],
      nextRunAt: past,
      scope,
      createdAt: now,
      updatedAt: now,
    });

    expect(await listSchedules(layerA)).toEqual([]);
    expect(await listSchedules(layerB)).toEqual([]);

    await upsertSchedule(ctx.layer, { ...schedule("unbound", "project"), id: "unbound-id" });
    expect(await listSchedules(layerA)).toEqual([]);
    expect(await listSchedules(layerB)).toEqual([]);

    await upsertSchedule(layerA, schedule("project-a", "project"));
    await upsertSchedule(layerB, schedule("project-b-global", "global"));

    const storeA = new AutomationStore("/tmp/fusion-automation-project-a", { asyncLayer: layerA });
    const storeB = new AutomationStore("/tmp/fusion-automation-project-b", { asyncLayer: layerB });
    expect((await storeA.listSchedules()).map(({ name }) => name)).toEqual(["project-a"]);
    expect((await storeB.listSchedules()).map(({ name }) => name)).toEqual(["project-b-global"]);

    await storeA.updateSchedule(duplicateId, { name: "project-a-updated" });
    expect((await storeA.getSchedule(duplicateId)).name).toBe("project-a-updated");
    expect((await storeB.getSchedule(duplicateId)).name).toBe("project-b-global");

    expect((await storeA.getDueSchedules("project")).map(({ name }) => name)).toEqual(["project-a-updated"]);
    expect((await storeB.getDueSchedules("project"))).toEqual([]);
    expect((await storeB.getDueSchedules("global")).map(({ name }) => name)).toEqual(["project-b-global"]);

    expect(await storeA.claimDueSchedule(duplicateId, past)).toBe(true);
    expect(await storeA.getDueSchedules("project")).toEqual([]);
    expect((await storeB.getDueSchedules("global")).map(({ name }) => name)).toEqual(["project-b-global"]);

    await storeA.deleteSchedule(duplicateId);
    expect(await storeA.listSchedules()).toEqual([]);
    expect((await storeB.listSchedules()).map(({ name }) => name)).toEqual(["project-b-global"]);
  });

  // ── RoutineStore ──

  it("RoutineStore: create (cron trigger) → get → list → update → due query → delete", async () => {
    ctx = await setupCtx();
    const { upsertRoutine, getRoutine, findRoutine, listRoutines, deleteRoutine, getDueRoutines } = await import("../../async-routine-store.js");
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    const routine = {
      id: `routine-${randomUUID().slice(0, 8)}`,
      agentId: "agent-1",
      name: "Health Check",
      description: "Check system health",
      trigger: { type: "cron" as const, cronExpression: "*/5 * * * *", timezone: "UTC" },
      command: "fn health",
      steps: undefined,
      timeoutMs: 30_000,
      catchUpPolicy: "run_one" as const,
      executionPolicy: "queue" as const,
      enabled: true,
      lastRunAt: undefined,
      lastRunResult: undefined,
      nextRunAt: past,
      runCount: 0,
      runHistory: [],
      catchUpLimit: 5,
      cronExpression: "*/5 * * * *",
      scope: "project" as const,
      createdAt: now,
      updatedAt: now,
    };

    await upsertRoutine(ctx.layer.db, routine);
    const fetched = await getRoutine(ctx.layer.db, routine.id);
    expect(fetched.name).toBe("Health Check");
    expect(fetched.trigger.type).toBe("cron");
    expect(fetched.trigger).toEqual({ type: "cron", cronExpression: "*/5 * * * *", timezone: "UTC" });
    expect(fetched.enabled).toBe(true);
    expect(fetched.agentId).toBe("agent-1");

    // List
    const all = await listRoutines(ctx.layer.db);
    expect(all).toHaveLength(1);

    // Due query
    const due = await getDueRoutines(ctx.layer.db, now, "project");
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe(routine.id);

    // Update (change trigger to manual)
    const updated = {
      ...routine,
      trigger: { type: "manual" as const },
      enabled: false,
      cronExpression: undefined,
      nextRunAt: undefined,
      updatedAt: now,
    };
    await upsertRoutine(ctx.layer.db, updated);
    const afterUpdate = await getRoutine(ctx.layer.db, routine.id);
    expect(afterUpdate.trigger.type).toBe("manual");
    expect(afterUpdate.enabled).toBe(false);

    // Disabled routine is not due
    const dueAfterDisable = await getDueRoutines(ctx.layer.db, now, "project");
    expect(dueAfterDisable).toHaveLength(0);

    // Delete
    expect(await deleteRoutine(ctx.layer.db, routine.id)).toBe(true);
    expect(await findRoutine(ctx.layer.db, routine.id)).toBeUndefined();
  });

  it("RoutineStore: webhook + api trigger config round-trips through jsonb", async () => {
    ctx = await setupCtx();
    const { upsertRoutine, getRoutine } = await import("../../async-routine-store.js");
    const now = new Date().toISOString();

    const webhookRoutine = {
      id: `rw-${randomUUID().slice(0, 8)}`,
      agentId: "agent-2",
      name: "Webhook Routine",
      trigger: { type: "webhook" as const, webhookPath: "/hook/test", secret: "s3cr3t" },
      command: "fn run",
      catchUpPolicy: "run_one" as const,
      executionPolicy: "queue" as const,
      enabled: true,
      runCount: 0,
      runHistory: [],
      catchUpLimit: 5,
      scope: "project" as const,
      createdAt: now,
      updatedAt: now,
    };
    await upsertRoutine(ctx.layer.db, webhookRoutine);
    const fetched = await getRoutine(ctx.layer.db, webhookRoutine.id);
    expect(fetched.trigger).toEqual({ type: "webhook", webhookPath: "/hook/test", secret: "s3cr3t" });

    const apiRoutine = {
      id: `ra-${randomUUID().slice(0, 8)}`,
      agentId: "agent-3",
      name: "API Routine",
      trigger: { type: "api" as const, endpoint: "/api/trigger" },
      command: "fn api-run",
      catchUpPolicy: "run_one" as const,
      executionPolicy: "queue" as const,
      enabled: true,
      runCount: 0,
      runHistory: [],
      catchUpLimit: 5,
      scope: "global" as const,
      createdAt: now,
      updatedAt: now,
    };
    await upsertRoutine(ctx.layer.db, apiRoutine);
    const apiFetched = await getRoutine(ctx.layer.db, apiRoutine.id);
    expect(apiFetched.trigger).toEqual({ type: "api", endpoint: "/api/trigger" });
    expect(apiFetched.scope).toBe("global");
  });

  // ── PluginStore (VAL-DATA-016) ──

  it("PluginStore: register → get → list → enable/disable → state → settings → update → unregister (VAL-DATA-016)", async () => {
    ctx = await setupCtx();
    const {
      registerPlugin, getPlugin, listPlugins, enablePlugin, disablePlugin,
      updatePluginState, updatePluginSettings, updatePluginInstall, unregisterPlugin,
      getProjectState,
    } = await import("../../async-plugin-store.js");

    const projectPath = "/test/project";
    const manifest = {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      author: "Test",
      homepage: "https://example.com",
      dependencies: [],
      settingsSchema: {
        apiKey: { type: "string" as const, required: false, defaultValue: "" },
      },
    };

    const plugin = await registerPlugin(ctx.layer, {
      manifest,
      path: "/plugins/test-plugin",
      settings: { apiKey: "secret-key" },
      aiScanOnLoad: true,
      projectPath,
    });

    expect(plugin.id).toBe("test-plugin");
    expect(plugin.enabled).toBe(true);
    expect(plugin.state).toBe("installed");
    expect(plugin.settings.apiKey).toBe("secret-key");
    expect(plugin.aiScanOnLoad).toBe(true);
    expect(plugin.dependencies).toEqual([]);

    // getPlugin
    const fetched = await getPlugin(ctx.layer.db, "test-plugin", projectPath);
    expect(fetched.name).toBe("Test Plugin");

    // listPlugins
    const all = await listPlugins(ctx.layer.db, projectPath);
    expect(all).toHaveLength(1);

    // disable / enable
    const disabled = await disablePlugin(ctx.layer.db, "test-plugin", projectPath);
    expect(disabled.enabled).toBe(false);
    const stateAfterDisable = await getProjectState(ctx.layer.db, projectPath, "test-plugin");
    expect(stateAfterDisable?.enabled).toBe(0);

    const enabled = await enablePlugin(ctx.layer.db, "test-plugin", projectPath);
    expect(enabled.enabled).toBe(true);

    // updatePluginState (installed -> started)
    const started = await updatePluginState(ctx.layer.db, "test-plugin", projectPath, "started");
    expect(started.state).toBe("started");

    // error state with error message
    const errored = await updatePluginState(ctx.layer.db, "test-plugin", projectPath, "error", "Crashed");
    expect(errored.state).toBe("error");
    expect(errored.error).toBe("Crashed");

    // updatePluginSettings (merge)
    await updatePluginSettings(ctx.layer.db, "test-plugin", { apiKey: "new-key", extra: "val" });
    const afterSettings = await getPlugin(ctx.layer.db, "test-plugin", projectPath);
    expect(afterSettings.settings.apiKey).toBe("new-key");
    expect(afterSettings.settings.extra).toBe("val");

    // updatePluginInstall (version bump + dependencies + lastSecurityScan jsonb-in-text)
    await updatePluginInstall(ctx.layer.db, "test-plugin", {
      version: "1.1.0",
      dependencies: ["dep-a"],
      lastSecurityScan: { passed: true, issues: [] },
    });
    const afterUpdate = await getPlugin(ctx.layer.db, "test-plugin", projectPath);
    expect(afterUpdate.version).toBe("1.1.0");
    expect(afterUpdate.dependencies).toEqual(["dep-a"]);
    expect(afterUpdate.lastSecurityScan).toEqual({ passed: true, issues: [] });

    // filter list by enabled
    const enabledOnly = await listPlugins(ctx.layer.db, projectPath, { enabled: true });
    expect(enabledOnly).toHaveLength(1);

    // unregister (cascade deletes project state)
    const deleted = await unregisterPlugin(ctx.layer.db, "test-plugin", projectPath);
    expect(deleted.id).toBe("test-plugin");
    await expect(getPlugin(ctx.layer.db, "test-plugin", projectPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("PluginStore: duplicate registration throws EEXISTS", async () => {
    ctx = await setupCtx();
    const { registerPlugin } = await import("../../async-plugin-store.js");
    const manifest = { id: "dup-plugin", name: "Dup", version: "1.0.0", dependencies: [] };
    await registerPlugin(ctx.layer, { manifest, path: "/p", projectPath: "/proj" });
    await expect(
      registerPlugin(ctx.layer, { manifest, path: "/p2", projectPath: "/proj" }),
    ).rejects.toMatchObject({ code: "EEXISTS" });
  });

  // ── AgentStore ──

  it("AgentStore: write/read agent (jsonb data) → list → find by name → delete", async () => {
    ctx = await setupCtx();
    const { writeAgent, readAgent, listAgentRows, findAgentRowsByName, deleteAgent, agentToData } = await import("../../async-agent-store.js");
    const now = new Date().toISOString();
    const agent = {
      id: `agent-${randomUUID().slice(0, 8)}`,
      name: "Test Agent",
      role: "orchestrator" as const,
      state: "active" as const,
      createdAt: now,
      updatedAt: now,
      metadata: { team: "alpha" },
      title: "Lead",
      runtimeConfig: { enabled: true, heartbeatIntervalMs: 3600000 },
      permissions: { createTask: true },
      totalInputTokens: 100,
      totalOutputTokens: 50,
    };

    await writeAgent(ctx.layer.db, agent);
    const fetched = await readAgent(ctx.layer.db, agent.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(agent.id);
    expect(fetched!.name).toBe("Test Agent");
    expect(fetched!.role).toBe("orchestrator");
    expect(fetched!.state).toBe("active");
    expect(fetched!.metadata).toEqual({ team: "alpha" });
    expect(fetched!.title).toBe("Lead");
    expect(fetched!.runtimeConfig).toEqual({ enabled: true, heartbeatIntervalMs: 3600000 });
    expect(fetched!.totalInputTokens).toBe(100);

    // agentToData round-trips the extended fields
    const data = agentToData(agent);
    expect(data.title).toBe("Lead");

    // Update via upsert (change state)
    await writeAgent(ctx.layer.db, { ...agent, state: "paused", pauseReason: "testing", updatedAt: now });
    const afterUpdate = await readAgent(ctx.layer.db, agent.id);
    expect(afterUpdate!.state).toBe("paused");
    expect(afterUpdate!.pauseReason).toBe("testing");

    // list filtered by state
    const paused = await listAgentRows(ctx.layer.db, { state: "paused" });
    expect(paused).toHaveLength(1);
    const active = await listAgentRows(ctx.layer.db, { state: "active" });
    expect(active).toHaveLength(0);

    // find by name
    const byName = await findAgentRowsByName(ctx.layer.db, "Test Agent");
    expect(byName).toHaveLength(1);

    // delete
    expect(await deleteAgent(ctx.layer.db, agent.id)).toBe(true);
    expect(await readAgent(ctx.layer.db, agent.id)).toBeNull();
  });

  it("AgentStore: heartbeat event + history round-trip", async () => {
    ctx = await setupCtx();
    const { writeAgent, recordHeartbeat, getHeartbeatHistory } = await import("../../async-agent-store.js");
    const now = new Date().toISOString();
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    await writeAgent(ctx.layer.db, { id: agentId, name: "HB", role: "worker", state: "active", createdAt: now, updatedAt: now, metadata: {} });

    await recordHeartbeat(ctx.layer.db, { agentId, timestamp: now, status: "ok", runId: "run-1" });
    await recordHeartbeat(ctx.layer.db, { agentId, timestamp: new Date(Date.now() + 1000).toISOString(), status: "missed", runId: "run-1" });

    const history = await getHeartbeatHistory(ctx.layer.db, agentId, 10);
    expect(history).toHaveLength(2);
    // newest first
    expect(history[0]!.status).toBe("missed");
    expect(history[1]!.status).toBe("ok");
  });

  it("AgentStore: run save/get/recent/active-list/status-counts round-trip", async () => {
    ctx = await setupCtx();
    const { saveRun, getRunDetail, getRunById, getRecentRuns, listActiveHeartbeatRuns, getRunStatusCounts, insertRunIfAbsent } = await import("../../async-agent-store.js");
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    await seedAgent(ctx.layer, agentId);
    const run = {
      id: `run-${randomUUID().slice(0, 8)}`,
      agentId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active" as const,
    };

    await saveRun(ctx.layer.db, ctx.layer.projectId ?? "", run);
    expect((await getRunDetail(ctx.layer.db, ctx.layer.projectId ?? "", agentId, run.id))?.id).toBe(run.id);
    const byId = await getRunById(ctx.layer.db, ctx.layer.projectId ?? "", run.id);
    expect(byId?.agentId).toBe(agentId);
    expect(byId?.run?.id).toBe(run.id);

    // recent runs
    const recent = await getRecentRuns(ctx.layer.db, ctx.layer.projectId ?? "", agentId, 10);
    expect(recent).toHaveLength(1);

    // active list
    const active = await listActiveHeartbeatRuns(ctx.layer.db, ctx.layer.projectId ?? "");
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(run.id);

    // end the run
    const endedRun = { ...run, endedAt: new Date().toISOString(), status: "completed" as const };
    await saveRun(ctx.layer.db, ctx.layer.projectId ?? "", endedRun);
    const counts = await getRunStatusCounts(ctx.layer.db, ctx.layer.projectId ?? "", [agentId]);
    expect(counts.completedRuns).toBe(1);
    expect(counts.failedRuns).toBe(0);

    // insertRunIfAbsent is a no-op on existing
    expect(await insertRunIfAbsent(ctx.layer.db, ctx.layer.projectId ?? "", run)).toBe(false);
  });

  it("AgentStore: task session upsert/get/delete", async () => {
    ctx = await setupCtx();
    const { upsertTaskSession, getTaskSession, deleteTaskSession } = await import("../../async-agent-store.js");
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    await seedAgent(ctx.layer, agentId);
    const taskId = "FN-1";
    const session = { agentId, taskId, context: { step: 1 }, notes: "first" } as never;

    await upsertTaskSession(ctx.layer.db, session);
    expect((await getTaskSession(ctx.layer.db, agentId, taskId))?.taskId).toBe(taskId);

    // update
    await upsertTaskSession(ctx.layer.db, { agentId, taskId, context: { step: 2 }, notes: "second" } as never);
    const updated = await getTaskSession(ctx.layer.db, agentId, taskId);
    expect((updated as { notes?: string })?.notes).toBe("second");

    await deleteTaskSession(ctx.layer.db, agentId, taskId);
    expect(await getTaskSession(ctx.layer.db, agentId, taskId)).toBeNull();
  });

  it("AgentStore: API key insert/list/revoke", async () => {
    ctx = await setupCtx();
    const { insertApiKey, readApiKeys, revokeApiKeyRow } = await import("../../async-agent-store.js");
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    await seedAgent(ctx.layer, agentId);
    const now = new Date().toISOString();
    const key = { id: `key-${randomUUID().slice(0, 8)}`, agentId, tokenHash: "hash-abc", createdAt: now };

    await insertApiKey(ctx.layer.db, key);
    const keys = await readApiKeys(ctx.layer.db, agentId);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.tokenHash).toBe("hash-abc");

    // revoke
    const revoked = { ...key, revokedAt: now };
    await revokeApiKeyRow(ctx.layer.db, key.id, agentId, revoked);
    const afterRevoke = await readApiKeys(ctx.layer.db, agentId);
    expect(afterRevoke[0]!.revokedAt).toBe(now);
  });

  it("AgentStore: config revision append/read/find", async () => {
    ctx = await setupCtx();
    const { appendConfigRevision, readConfigRevisions, findConfigRevisionById } = await import("../../async-agent-store.js");
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    await seedAgent(ctx.layer, agentId);
    const revision = {
      id: `rev-${randomUUID().slice(0, 8)}`,
      agentId,
      createdAt: new Date().toISOString(),
      before: { name: "Old" } as never,
      after: { name: "New" } as never,
      diffs: [{ field: "name", before: "Old", after: "New" }] as never,
      summary: "Updated name",
      source: "user" as const,
    };

    await appendConfigRevision(ctx.layer.db, revision);
    const revisions = await readConfigRevisions(ctx.layer.db, agentId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.summary).toBe("Updated name");

    const found = await findConfigRevisionById(ctx.layer.db, revision.id);
    expect(found?.id).toBe(revision.id);
  });

  it("AgentStore: rating add/get/filter/delete with score CHECK constraint", async () => {
    ctx = await setupCtx();
    const { addRating, getRatings, deleteRating } = await import("../../async-agent-store.js");
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const r1 = { id: `r-${randomUUID().slice(0, 8)}`, agentId, raterType: "user" as const, score: 5, category: "quality", comment: "great", createdAt: now };
    const r2 = { id: `r-${randomUUID().slice(0, 8)}`, agentId, raterType: "agent" as const, raterId: "a-1", score: 3, category: "speed", createdAt: now };
    await addRating(ctx.layer.db, r1);
    await addRating(ctx.layer.db, r2);

    const all = await getRatings(ctx.layer.db, agentId);
    expect(all).toHaveLength(2);

    const quality = await getRatings(ctx.layer.db, agentId, { category: "quality" });
    expect(quality).toHaveLength(1);
    expect(quality[0]!.score).toBe(5);

    const limited = await getRatings(ctx.layer.db, agentId, { limit: 1 });
    expect(limited).toHaveLength(1);

    // Score CHECK constraint rejects out-of-range scores (VAL-SCHEMA-005)
    await expect(
      addRating(ctx.layer.db, { id: `r-${randomUUID().slice(0, 8)}`, agentId, raterType: "user", score: 0, createdAt: now }),
    ).rejects.toThrow();

    expect(await deleteRating(ctx.layer.db, r1.id)).toBe(true);
    expect(await getRatings(ctx.layer.db, agentId)).toHaveLength(1);
  });

  it("AgentStore: blocked state set/get/clear + all-blocked snapshot", async () => {
    ctx = await setupCtx();
    const { getLastBlockedState, setLastBlockedState, clearLastBlockedState, getAllBlockedStates } = await import("../../async-agent-store.js");
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    await seedAgent(ctx.layer, agentId);
    const state = { taskId: "FN-1", reason: "stuck", at: new Date().toISOString() } as never;

    expect(await getLastBlockedState(ctx.layer.db, agentId)).toBeNull();
    await setLastBlockedState(ctx.layer.db, agentId, state);
    expect((await getLastBlockedState(ctx.layer.db, agentId))?.taskId).toBe("FN-1");

    // update (upsert)
    const state2 = { taskId: "FN-2", reason: "blocked", at: new Date().toISOString() } as never;
    await setLastBlockedState(ctx.layer.db, agentId, state2);
    expect((await getLastBlockedState(ctx.layer.db, agentId))?.taskId).toBe("FN-2");

    const all = await getAllBlockedStates(ctx.layer.db);
    expect(all).toHaveLength(1);
    expect(all[0]!.agentId).toBe(agentId);

    await clearLastBlockedState(ctx.layer.db, agentId);
    expect(await getLastBlockedState(ctx.layer.db, agentId)).toBeNull();
  });

  it("AgentStore: __meta migration marker upsert/get", async () => {
    ctx = await setupCtx();
    const { getMetaValue, upsertMetaValue } = await import("../../async-agent-store.js");
    const key = "testMigrationMarker";

    expect(await getMetaValue(ctx.layer.db, key)).toBeUndefined();
    await upsertMetaValue(ctx.layer.db, key, "1");
    expect(await getMetaValue(ctx.layer.db, key)).toBe("1");
    // update
    await upsertMetaValue(ctx.layer.db, key, "2");
    expect(await getMetaValue(ctx.layer.db, key)).toBe("2");
  });
});
