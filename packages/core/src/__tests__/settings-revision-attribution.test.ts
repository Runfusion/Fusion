import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { AutomationStore } from "../automation/automation-store.js";
import { RoutineStore } from "../automation/routine-store.js";
import type { ConfigChangedBy } from "../types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
FNXC:ConfigVersioning 2026-08-09-04:06:
Configuration provenance is an immutable persisted audit record, so default
attribution tests read JSONB revisions back instead of only inspecting callers.
*/
pgDescribe("settings revision attribution", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_settings_attribution" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /*
  FNXC:ConfigVersioning 2026-08-16-20:17:
  A snapshot-difference window admits late background revisions after a harness
  reset. Attribution assertions instead compose only immutable IDs whose target
  or payload is uniquely owned by this test's writes.
  */
  async function revisionIdsForTarget(configKind: string, configTarget: Record<string, string>) {
    const rows = await h.adminDb().execute(sql`
      SELECT id
      FROM project.configuration_revisions
      WHERE config_kind = ${configKind}
        AND config_target @> ${JSON.stringify(configTarget)}::jsonb
      ORDER BY created_at ASC, sequence ASC, id ASC
    `) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async function revisionIdForAfterValue(configKind: string, key: string, value: string) {
    const rows = await h.adminDb().execute(sql`
      SELECT id
      FROM project.configuration_revisions
      WHERE config_kind = ${configKind}
        AND "after" ->> ${key} = ${value}
      ORDER BY created_at DESC, sequence DESC, id DESC
    `) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  }

  async function revisionForTaskPrefix(taskPrefix: string) {
    const rows = await h.adminDb().execute(sql`
      SELECT id, config_kind AS "configKind", changed_by AS "changedBy"
      FROM project.configuration_revisions
      WHERE config_kind = 'project-settings'
        AND "after" ->> 'taskPrefix' = ${taskPrefix}
      ORDER BY created_at DESC, sequence DESC, id DESC
    `) as Array<{ id: string; configKind: string; changedBy: ConfigChangedBy }>;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function revisionById(id: string) {
    const rows = await h.adminDb().execute(sql`
      SELECT id, config_kind AS "configKind", changed_by AS "changedBy"
      FROM project.configuration_revisions
      WHERE id = ${id}
    `) as Array<{ id: string; configKind: string; changedBy: ConfigChangedBy }>;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it("persists system for every omitted-actor configuration writer", async () => {
    const store = h.store();
    const layer = { ...store.getAsyncLayer()!, projectId: store.getWorkflowSettingsProjectId() };
    const automationStore = new AutomationStore(h.rootDir, { asyncLayer: layer });
    const routineStore = new RoutineStore(h.rootDir, { asyncLayer: layer });
    await store.updateSettings({ taskPrefix: "ATR" });
    const projectRevisionId = (await revisionForTaskPrefix("ATR")).id;
    await store.updateGlobalSettings({ defaultModelId: "attribution-model" });
    const globalRevisionId = await revisionIdForAfterValue("global-settings", "defaultModelId", "attribution-model");
    const directGlobal = await store.globalSettingsStore.updateSettings({ defaultModelId: "direct-attribution-model" });
    const directGlobalRevisionId = await revisionIdForAfterValue("global-settings", "defaultModelId", "direct-attribution-model");
    const workflowProjectId = store.getWorkflowSettingsProjectId();
    await store.updateWorkflowSettingValues("builtin:coding", workflowProjectId, { workflowStepTimeoutMs: 1_000 });
    const [workflowRevisionId] = await revisionIdsForTarget("workflow-settings", { workflowId: "builtin:coding", projectId: workflowProjectId });
    expect(workflowRevisionId).toBeDefined();

    const schedule = await automationStore.createSchedule({
      name: "Attribution schedule", scheduleType: "daily", command: "",
      steps: [
        { id: "first", type: "command", name: "First", command: "echo first" },
        { id: "second", type: "command", name: "Second", command: "echo second" },
      ],
    });
    await automationStore.updateSchedule(schedule.id, { name: "Updated attribution schedule" });
    await automationStore.reorderSteps(schedule.id, ["second", "first"]);

    const routine = await routineStore.createRoutine({
      agentId: "attribution-agent", name: "Attribution routine", trigger: { type: "manual" }, command: "echo attribution",
    });
    await routineStore.updateRoutine(routine.id, { name: "Updated attribution routine" });

    const automationRevisionIds = await revisionIdsForTarget("automation", { automationId: schedule.id });
    expect(automationRevisionIds).toHaveLength(3);
    const globalRollback = await store.globalSettingsStore.rollbackConfiguration(globalRevisionId);
    await automationStore.rollbackConfiguration(automationRevisionIds[1]!);
    await automationStore.deleteSchedule(schedule.id);

    const routineRevisionIds = await revisionIdsForTarget("routine", { routineId: routine.id });
    expect(routineRevisionIds).toHaveLength(2);
    await routineStore.rollbackConfiguration(routineRevisionIds[1]!);
    await routineStore.deleteRoutine(routine.id);

    /* FNXC:ConfigVersioning 2026-08-16-20:17: A post-snapshot system revision must not join this test-owned actor set. */
    await store.updateSettings({ taskPrefix: "ATR-background" });

    const ownedRevisionIds = [
      projectRevisionId,
      globalRevisionId,
      directGlobalRevisionId,
      workflowRevisionId!,
      ...(await revisionIdsForTarget("automation", { automationId: schedule.id })),
      ...(await revisionIdsForTarget("routine", { routineId: routine.id })),
      globalRollback.id,
    ];
    expect(new Set(ownedRevisionIds).size).toBe(14);
    const actors = (await Promise.all(ownedRevisionIds.map(revisionById))).map((revision) => revision.changedBy);
    expect(actors).toHaveLength(14);
    expect(actors).toEqual(Array.from({ length: 14 }, () => ({ kind: "system", id: "fusion-system" })));
    expect(actors).not.toContainEqual(expect.objectContaining({ kind: "human" }));
    expect(directGlobal.defaultModelId).toBe("direct-attribution-model");
  });

  it("round-trips every explicit provenance variant through committed JSONB revisions", async () => {
    const store = h.store();
    const actors: ConfigChangedBy[] = [
      { kind: "human", id: "future-auth-user" },
      { kind: "agent", id: "agent-1" },
      { kind: "system", id: "system-test" },
      { kind: "api", id: "http:test-verified" },
      { kind: "rollback", id: "rollback-test" },
    ];
    const revisionIds: string[] = [];

    for (const [index, actor] of actors.entries()) {
      const taskPrefix = `ATR${index}`;
      await store.updateSettings({ taskPrefix }, actor);
      revisionIds.push((await revisionForTaskPrefix(taskPrefix)).id);
    }

    /* FNXC:ConfigVersioning 2026-08-16-20:00: A background system write after the explicit writes must not enter their ID-addressed provenance assertion. */
    const lateBackgroundWrite = Promise.resolve().then(() => store.updateSettings({ taskPrefix: "ATR-background" }));
    await lateBackgroundWrite;

    expect((await Promise.all(revisionIds.map(revisionById))).map((revision) => revision.changedBy)).toEqual(actors);
  });
});
