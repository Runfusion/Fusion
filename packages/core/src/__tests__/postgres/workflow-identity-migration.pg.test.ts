import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pgDescribe, createBaselinedPgTestDatabase } from "../../__test-utils__/pg-test-harness.js";
import { SCHEMA_BASELINE_VERSION, WORKFLOW_IDENTITY_AND_MODEL_LANES_VERSION } from "../../postgres/schema-applier.js";

const migrationPath = new URL("../../postgres/migrations/0079_fn_393_workflow_identity_and_project_model_lanes.sql", import.meta.url);
const migration = readFileSync(migrationPath, "utf8");
describe("workflow identity migration registration", () => {
  it("registers every startup hook before identity reads", () => {
    const applier = readFileSync(new URL("../../postgres/schema-applier.ts", import.meta.url), "utf8");
    expect(SCHEMA_BASELINE_VERSION).toBe("0079");
    expect(WORKFLOW_IDENTITY_AND_MODEL_LANES_VERSION).toBe("0079");
    expect(applier).toContain("0079_fn_393_workflow_identity_and_project_model_lanes.sql");
    expect(applier).toContain("applied.includes(WORKFLOW_IDENTITY_AND_MODEL_LANES_VERSION)");
    expect(applier).toContain('readFile(WORKFLOW_IDENTITY_AND_MODEL_LANES_MIGRATION_PATH, "utf8")');
    expect(applier).toContain('VALUES (${WORKFLOW_IDENTITY_AND_MODEL_LANES_VERSION}) ON CONFLICT');
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS project.archived_workflow_settings");
    for (const role of ["execution", "planning", "validator"]) {
      for (const suffix of ["Provider", "ModelId", "ThinkingLevel", "CredentialInstanceId", "FallbackProvider", "FallbackModelId", "FallbackThinkingLevel", "FallbackCredentialInstanceId"]) {
        expect(migration).toContain(role + suffix);
      }
    }
  });
});

async function setupBaselinedDb() {
  const fixture = await createBaselinedPgTestDatabase("fusion_identity_migration");
  const sqlConn = postgres(fixture.testUrl, { max: 1, prepare: false, onnotice: () => {} });
  return { sqlConn, db: drizzle(sqlConn), drop: fixture.drop };
}
type TestContext = Awaited<ReturnType<typeof setupBaselinedDb>>;
async function teardownDb(ctx: TestContext | null) {
  if (!ctx) return;
  await ctx.sqlConn.end({ timeout: 5 });
  await ctx.drop();
}

pgDescribe("schema-applier: Coding (Ideas) stable identity migration", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await teardownDb(ctx);
    ctx = null;
  });

  it("archives collisions, keeps v2 as the winner, rewrites references, and is idempotent", async () => {
    ctx = await setupBaselinedDb();
    await ctx.db.execute(sql`SELECT set_config('fusion.project_id', 'identity-project', false)`);
    await ctx.db.execute(sql.raw(`
      INSERT INTO project.config (project_id, id, settings, updated_at)
      VALUES ('identity-project', 1, '{"defaultWorkflowId":"builtin:coding-ideas-v2","enabledBuiltinWorkflowIds":["builtin:coding-ideas","builtin:coding-ideas-v2"],"workflowCapacityPools":{"builtin:coding-ideas":1,"builtin:coding-ideas-v2":2}}', 'config-time')
      ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at;

      INSERT INTO project.tasks (project_id, id, title, description, "column", created_at, updated_at)
      VALUES ('identity-project', 'FN-ID', 'Identity', 'Identity migration fixture', 'todo', 'created', 'updated');
      INSERT INTO project.task_workflow_selection (project_id, task_id, workflow_id, step_ids, updated_at)
      VALUES ('identity-project', 'FN-ID', 'builtin:coding-ideas-v2', '[]', 'selection-time');

      INSERT INTO project.workflow_settings (project_id, workflow_id, values, updated_at) VALUES
        ('identity-project', 'builtin:coding-ideas', '{"policy":"old-policy","executionModelId":"old-model"}', 'old-settings-time'),
        ('identity-project', 'builtin:coding-ideas-v2', '{"policy":"winner-policy","planningProvider":"winner-provider"}', 'winner-settings-time');
      INSERT INTO project.workflow_prompt_overrides (project_id, workflow_id, overrides, updated_at) VALUES
        ('identity-project', 'builtin:coding-ideas', '{"review":"old prompt"}', 'old-prompts-time'),
        ('identity-project', 'builtin:coding-ideas-v2', '{"review":"winner prompt"}', 'winner-prompts-time');

      INSERT INTO project.boards (project_id, id, name, description, workflow_id, ordering, require_plan_approval, lfg_mode, created_at, updated_at)
      VALUES ('identity-project', 'board-id', 'Board', '', 'builtin:coding-ideas-v2', 0, 0, 0, 'created', 'updated');
    `));

    const originalTask = await ctx.db.execute(sql`SELECT to_jsonb(t) AS row FROM project.tasks t WHERE project_id = 'identity-project' AND id = 'FN-ID'`);
    const migration = readFileSync(
      fileURLToPath(new URL("../../postgres/migrations/0079_fn_393_workflow_identity_and_project_model_lanes.sql", import.meta.url)),
      "utf8",
    );
    await ctx.db.execute(sql.raw(migration));
    await ctx.db.execute(sql.raw(migration));

    expect(await ctx.db.execute(sql`SELECT to_jsonb(t) AS row FROM project.tasks t WHERE project_id = 'identity-project' AND id = 'FN-ID'`)).toEqual(originalTask);
    const archivedConfig = await ctx.db.execute(sql`SELECT values FROM project.archived_workflow_settings WHERE project_id = 'identity-project' AND values->>'source' = 'project.config'`) as unknown as Array<{ values: { settings: Record<string, unknown> } }>;
    expect(archivedConfig).toHaveLength(1);
    expect(archivedConfig[0].values.settings.workflowCapacityPools).toEqual({ 'builtin:coding-ideas': 1, 'builtin:coding-ideas-v2': 2 });
    const settings = await ctx.db.execute(sql.raw(`
      SELECT workflow_id, values FROM project.workflow_settings
      WHERE project_id = 'identity-project'
    `)) as unknown as Array<{ workflow_id: string; values: Record<string, unknown> }>;
    expect(settings).toEqual([{ workflow_id: "builtin:coding-ideas", values: { policy: "winner-policy" } }]);

    const prompt = await ctx.db.execute(sql.raw(`
      SELECT workflow_id, overrides FROM project.workflow_prompt_overrides
      WHERE project_id = 'identity-project'
    `)) as unknown as Array<{ workflow_id: string; overrides: Record<string, unknown> }>;
    expect(prompt).toEqual([{ workflow_id: "builtin:coding-ideas", overrides: { review: "winner prompt" } }]);

    const settingsArchive = await ctx.db.execute(sql.raw(`
      SELECT workflow_id, values, reason FROM project.archived_workflow_settings
      WHERE project_id = 'identity-project' AND NOT (values ? 'source') ORDER BY reason, workflow_id
    `)) as unknown as Array<{ workflow_id: string; values: Record<string, unknown>; reason: string }>;
    expect(settingsArchive).toEqual([
      { workflow_id: "builtin:coding-ideas", values: { policy: "old-policy", executionModelId: "old-model" }, reason: "identity-merge-loser" },
      { workflow_id: "builtin:coding-ideas", values: { policy: "old-policy", executionModelId: "old-model" }, reason: "model-lane-reset" },
      { workflow_id: "builtin:coding-ideas-v2", values: { policy: "winner-policy", planningProvider: "winner-provider" }, reason: "model-lane-reset" },
    ]);
    const promptArchive = await ctx.db.execute(sql.raw(`
      SELECT workflow_id, overrides, reason FROM project.workflow_prompt_overrides_archive
      WHERE project_id = 'identity-project'
    `)) as unknown as Array<{ workflow_id: string; overrides: Record<string, unknown>; reason: string }>;
    expect(promptArchive).toEqual([
      { workflow_id: "builtin:coding-ideas", overrides: { review: "old prompt" }, reason: "identity-merge-loser" },
    ]);

    const references = await ctx.db.execute(sql.raw(`
      SELECT
        (SELECT workflow_id FROM project.task_workflow_selection WHERE project_id = 'identity-project' AND task_id = 'FN-ID') AS task_workflow,
        (SELECT workflow_id FROM project.boards WHERE project_id = 'identity-project' AND id = 'board-id') AS board_workflow,
        (SELECT settings FROM project.config WHERE project_id = 'identity-project') AS config
    `)) as unknown as Array<{ task_workflow: string; board_workflow: string; config: Record<string, unknown> }>;
    expect(references[0]).toEqual({
      task_workflow: "builtin:coding-ideas",
      board_workflow: "builtin:coding-ideas",
      config: {
        defaultWorkflowId: "builtin:coding-ideas",
        enabledBuiltinWorkflowIds: ["builtin:coding-ideas"],
        workflowCapacityPools: { "builtin:coding-ideas": 2 },
      },
    });
  });
  it("isolates single-identity projects and removes every model companion without moving policy", async () => {
    ctx = await setupBaselinedDb();
    const lanes = Object.fromEntries(["execution", "planning", "validator"].flatMap(role =>
      ["Provider", "ModelId", "ThinkingLevel", "CredentialInstanceId", "FallbackProvider", "FallbackModelId", "FallbackThinkingLevel", "FallbackCredentialInstanceId"].map(suffix => [role + suffix, "configured"]),
    ));
    for (const [projectId, workflowId] of [["canonical-only", "builtin:coding-ideas"], ["revision-only", "builtin:coding-ideas-v2"], ["auto-only", "builtin:coding"]]) {
      await ctx.db.execute(sql`SELECT set_config('fusion.project_id', ${projectId}, false)`);
      await ctx.db.execute(sql`INSERT INTO project.workflow_settings(project_id,workflow_id,values,updated_at)
        VALUES (${projectId}, ${workflowId}, ${JSON.stringify({ ...lanes, workflowStepTimeoutMs: 123, codeReviewEnabled: true })}::jsonb, 'preserved-time')`);
      await ctx.db.execute(sql`INSERT INTO project.workflow_prompt_overrides(project_id,workflow_id,overrides,updated_at)
        VALUES (${projectId}, ${workflowId}, '{"plan":"preserved prompt"}', 'preserved-time')`);
    }
    await ctx.db.transaction(async tx => { await tx.execute(sql.raw(migration)); });
    for (const [projectId, workflowId] of [["canonical-only", "builtin:coding-ideas"], ["revision-only", "builtin:coding-ideas"], ["auto-only", "builtin:coding"]]) {
      const settings = await ctx.db.execute(sql`SELECT workflow_id, values, updated_at FROM project.workflow_settings WHERE project_id=${projectId}`);
      expect(settings).toEqual([{workflow_id: workflowId, values: {workflowStepTimeoutMs:123, codeReviewEnabled:true}, updated_at:'preserved-time'}]);
      expect(await ctx.db.execute(sql`SELECT workflow_id, overrides FROM project.workflow_prompt_overrides WHERE project_id=${projectId}`)).toEqual([{workflow_id: workflowId, overrides:{plan:'preserved prompt'}}]);
      const archived = await ctx.db.execute(sql`SELECT values FROM project.archived_workflow_settings WHERE project_id=${projectId} AND reason='model-lane-reset'`);
      expect(archived).toEqual([{values:{...lanes,workflowStepTimeoutMs:123,codeReviewEnabled:true}}]);
    }
    expect(await ctx.db.execute(sql`SELECT workflow_id FROM project.workflow_settings WHERE workflow_id='builtin:coding-ideas-v2'`)).toEqual([]);
  });

});

