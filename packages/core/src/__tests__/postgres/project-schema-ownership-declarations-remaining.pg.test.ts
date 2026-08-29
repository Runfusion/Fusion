import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import { createScheduleRow, listSchedules } from "../../async-stores/async-automation-store.js";
import {
  getIncidentAsync,
  ingestIncidentSignalAsync,
  recordDeploymentAsync,
} from "../../task-store/async/async-monitor.js";
import {
  listGitHubCheckStatesAsync,
  recordGitHubCheckStateAsync,
} from "../../task-store/async/async-ci-checks.js";
import {
  patchProjectSettings,
  readProjectConfig,
  writeProjectConfig,
} from "../../task-store/async/async-settings.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const tableNames = ["config", "automations", "deployments", "github_check_states", "incidents"] as const;
const declaredTables = {
  config: schema.project.config,
  automations: schema.project.automations,
  deployments: schema.project.deployments,
  github_check_states: schema.project.githubCheckStates,
  incidents: schema.project.incidents,
} as const;
const expectedPrimaryKeys: Record<(typeof tableNames)[number], string[]> = {
  config: ["project_id"], automations: ["project_id", "id"], deployments: ["project_id", "id"],
  github_check_states: ["project_id", "id"], incidents: ["project_id", "id"],
};

pgDescribe("remaining project schema ownership declarations", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_fn9004_schema", projectId: "fn9004-runtime-bound",
  });
  const unboundHarness: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_fn9004_schema_unbound",
  });
  beforeAll(async () => { await h.beforeAll(); await unboundHarness.beforeAll(); });
  afterAll(async () => { await unboundHarness.afterAll(); await h.afterAll(); });
  beforeEach(async () => { await h.beforeEach(); await unboundHarness.beforeEach(); });
  afterEach(async () => { await unboundHarness.afterEach(); await h.afterEach(); });

  it("matches the post-0006 catalog default and project-leading keys", async () => {
    /*
    FNXC:MultiProjectIsolation 2026-08-12-15:43:
    The declaration sweep must query PostgreSQL rather than infer physical keys from source
    migrations. This catches post-0006 tables such as github_check_states that missed its default.
    */
    for (const tableName of tableNames) {
      const columns = await h.adminSql()<Array<{ data_type: string; is_nullable: string; column_default: string | null }>>`
        SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'project' AND table_name = ${tableName} AND column_name = 'project_id'
      `;
      expect(columns).toEqual([expect.objectContaining({ data_type: "text", is_nullable: "NO", column_default: expect.stringContaining("current_setting") })]);
      const constraints = await h.adminSql()<Array<{ conname: string; contype: string; columns: string[] }>>`
        SELECT c.conname, c.contype, array_agg(a.attname ORDER BY k.ordinality) AS columns
        FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = ('project.' || ${tableName})::regclass AND c.contype IN ('p', 'u')
        GROUP BY c.conname, c.contype ORDER BY c.contype, c.conname
      `;
      expect(constraints.find((constraint) => constraint.contype === "p")?.columns).toEqual(expectedPrimaryKeys[tableName]);
      for (const constraint of constraints) expect(constraint.columns[0]).toBe("project_id");
      const declaration = getTableConfig(declaredTables[tableName]);
      expect(declaration.columns.find((column) => column.name === "project_id")?.hasDefault).toBe(true);
      const declaredPrimaryKey = tableName === "config"
        ? declaration.columns.filter((column) => column.primary).map((column) => column.name)
        : declaration.primaryKeys[0]?.columns.map((column) => column.name);
      expect(declaredPrimaryKey).toEqual(expectedPrimaryKeys[tableName]);
      expect(declaration.uniqueConstraints.map((constraint) => ({ name: constraint.getName(), columns: constraint.columns.map((column) => column.name) })))
        .toEqual(expect.arrayContaining(constraints.filter((constraint) => constraint.contype === "u").map((constraint) => ({ name: constraint.conname, columns: constraint.columns }))));
    }
  });

  it("preserves production writer ownership, conflict targets, and scoped reads", async () => {
    /*
    FNXC:MultiProjectIsolation 2026-08-12-15:57:
    Declaration introspection alone cannot prove Drizzle's composite conflict targets or public
    mappers. Exercise each owner-writing production helper through bound and unbound layers.
    */
    const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
    const projectA = bind("fn9004-writer-a");
    const projectB = bind("fn9004-writer-b");
    const unbound = unboundHarness.layer();
    const schedule = (id: string) => ({
      id, name: "Shared schedule", scheduleType: "custom" as const, cronExpression: "* * * * *",
      command: "echo shared", enabled: true, runCount: 0, runHistory: [],
      createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
    });
    await createScheduleRow(projectA, schedule("shared"));
    await createScheduleRow(projectB, schedule("shared"));
    expect(await listSchedules(projectA)).toMatchObject([{ id: "shared" }]);
    expect(await listSchedules(projectB)).toMatchObject([{ id: "shared" }]);
    await expect(createScheduleRow(unbound, schedule("unbound"))).rejects.toThrow("require asyncLayer.projectId");

    await recordDeploymentAsync(projectA.db, { deploymentId: "shared", status: "started" }, projectA.projectId);
    await expect(recordDeploymentAsync(projectA.db, { deploymentId: "shared", status: "complete" }, projectA.projectId))
      .resolves.toMatchObject({ deploymentId: "shared", status: "complete" });
    await recordDeploymentAsync(projectB.db, { deploymentId: "shared", status: "started" }, projectB.projectId);
    await recordDeploymentAsync(unbound.db, { deploymentId: "unbound" }, "");

    const incidentA = await ingestIncidentSignalAsync(projectA.db, {
      groupingKey: "shared", title: "Project A incident", at: "2026-08-12T00:00:00.000Z",
    }, projectA.projectId);
    const incidentB = await ingestIncidentSignalAsync(projectB.db, {
      groupingKey: "shared", title: "Project B incident", at: "2026-08-12T00:00:00.000Z",
    }, projectB.projectId);
    const unboundIncident = await ingestIncidentSignalAsync(unbound.db, {
      groupingKey: "unbound", title: "Legacy incident", at: "2026-08-12T00:00:00.000Z",
    }, "");
    expect(await getIncidentAsync(projectA.db, incidentA.incident.incidentId, projectA.projectId)).toMatchObject({ title: "Project A incident" });
    expect(await getIncidentAsync(projectB.db, incidentA.incident.incidentId, projectB.projectId)).toBeNull();
    expect(await getIncidentAsync(unbound.db, unboundIncident.incident.incidentId, "")).toMatchObject({ title: "Legacy incident" });
    expect(incidentB.incident.incidentId).not.toBe(incidentA.incident.incidentId);

    const check = { repo: "Owner/Repo", headSha: "shared", checkName: "ci/build", state: "success", reportedAt: "2026-08-12T00:00:00.000Z" };
    await recordGitHubCheckStateAsync(projectA, check, projectA.projectId!);
    await recordGitHubCheckStateAsync(projectB, check, projectB.projectId!);
    expect(await listGitHubCheckStatesAsync(projectA, { repo: check.repo, headSha: check.headSha }, projectA.projectId!)).toHaveLength(1);
    expect(await listGitHubCheckStatesAsync(projectB, { repo: check.repo, headSha: check.headSha }, projectB.projectId!)).toHaveLength(1);
    await expect(recordGitHubCheckStateAsync(unbound, check, " ")).rejects.toThrow("require asyncLayer.projectId");

    await writeProjectConfig(projectA, { owner: "a" });
    await patchProjectSettings(projectA, { patched: true });
    await writeProjectConfig(projectB, { owner: "b" });
    expect(await readProjectConfig(projectA)).toMatchObject({ settings: { owner: "a", patched: true } });
    expect(await readProjectConfig(projectB)).toMatchObject({ settings: { owner: "b" } });
    await writeProjectConfig(unbound, { owner: "legacy" });
    expect(await readProjectConfig(unbound)).toMatchObject({ settings: { owner: "legacy" } });

    expect(await h.adminSql()<Array<{ project_id: string; deployment_id: string }>>`
      SELECT project_id, deployment_id FROM project.deployments
      WHERE deployment_id = 'shared' ORDER BY project_id
    `).toEqual([
      { project_id: "fn9004-writer-a", deployment_id: "shared" },
      { project_id: "fn9004-writer-b", deployment_id: "shared" },
    ]);
    expect(await unboundHarness.adminSql()<Array<{ project_id: string }>>`
      SELECT project_id FROM project.deployments WHERE deployment_id = 'unbound'
    `).toEqual([{ project_id: "__legacy_unscoped__" }]);
  });

  it("stamps omitted owners and permits duplicate natural identities per partition", async () => {
    const insertRows = async (projectId: string): Promise<void> => {
      await h.adminSql()`SELECT set_config('fusion.project_id', ${projectId}, false)`;
      await h.adminSql()`INSERT INTO project.config (id, updated_at) VALUES (1, '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.automations (id, name, schedule_type, cron_expression, command, created_at, updated_at) VALUES ('shared', 'Shared', 'cron', '* * * * *', 'echo shared', '2026-08-12', '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.deployments (deployment_id, deployed_at, created_at) VALUES ('shared', '2026-08-12', '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.github_check_states (repo, head_sha, check_name, state, reported_at, received_at, created_at, updated_at) VALUES ('repo', 'sha', 'check', 'success', '2026-08-12', '2026-08-12', '2026-08-12', '2026-08-12')`;
      await h.adminSql()`INSERT INTO project.incidents (incident_id, grouping_key, title, status, opened_at, created_at, updated_at) VALUES ('shared', 'group', 'Shared', 'open', '2026-08-12', '2026-08-12', '2026-08-12')`;
    };
    await insertRows("fn9004-a"); await insertRows("fn9004-b");
    for (const tableName of tableNames) {
      const rows = await h.adminSql()<Array<{ count: string }>>`SELECT count(*)::text AS count FROM project.${h.adminSql().unsafe(tableName)} WHERE project_id IN ('fn9004-a', 'fn9004-b')`;
      expect(rows).toEqual([{ count: "2" }]);
    }
    await h.adminSql()`SELECT set_config('fusion.project_id', '', false)`;
    await h.adminSql()`INSERT INTO project.deployments (deployment_id, deployed_at, created_at) VALUES ('unbound', '2026-08-12', '2026-08-12')`;
    expect(await h.adminSql()<Array<{ project_id: string }>>`SELECT project_id FROM project.deployments WHERE deployment_id = 'unbound'`)
      .toEqual([{ project_id: "__legacy_unscoped__" }]);
  });
});
