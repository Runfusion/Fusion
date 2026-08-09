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

  async function revisions(): Promise<Array<{ id: string; configKind: string; changedBy: ConfigChangedBy }>> {
    return await h.adminDb().execute(sql`
      SELECT id, config_kind AS "configKind", changed_by AS "changedBy"
      FROM project.configuration_revisions
      ORDER BY sequence ASC
    `) as Array<{ id: string; configKind: string; changedBy: ConfigChangedBy }>;
  }

  async function revisionActors(): Promise<ConfigChangedBy[]> {
    return (await revisions()).map((row) => row.changedBy);
  }

  it("persists system for every omitted-actor configuration writer", async () => {
    const store = h.store();
    const layer = { ...store.getAsyncLayer()!, projectId: store.getWorkflowSettingsProjectId() };
    const automationStore = new AutomationStore(h.rootDir, { asyncLayer: layer });
    const routineStore = new RoutineStore(h.rootDir, { asyncLayer: layer });
    const before = await revisions();

    await store.updateSettings({ taskPrefix: "ATR" });
    await store.updateGlobalSettings({ defaultModelId: "attribution-model" });
    const directGlobal = await store.globalSettingsStore.updateSettings({ defaultModelId: "direct-attribution-model" });
    await store.updateWorkflowSettingValues("builtin:coding", store.getWorkflowSettingsProjectId(), { workflowStepTimeoutMs: 1_000 });

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

    const created = (await revisions()).slice(before.length);
    const globalRevision = created.find((revision) => revision.configKind === "global-settings");
    expect(globalRevision).toBeDefined();
    await store.globalSettingsStore.rollbackConfiguration(globalRevision!.id);

    const automationRevision = created.find((revision) => revision.configKind === "automation" && revision.id !== created.find((candidate) => candidate.configKind === "automation")?.id);
    expect(automationRevision).toBeDefined();
    await automationStore.rollbackConfiguration(automationRevision!.id);
    await automationStore.deleteSchedule(schedule.id);

    const routineRevision = created.find((revision) => revision.configKind === "routine" && revision.id !== created.find((candidate) => candidate.configKind === "routine")?.id);
    expect(routineRevision).toBeDefined();
    await routineStore.rollbackConfiguration(routineRevision!.id);
    await routineStore.deleteRoutine(routine.id);

    const actors = (await revisions()).slice(before.length).map((revision) => revision.changedBy);
    expect(actors).toHaveLength(14);
    expect(actors).toEqual(Array.from({ length: 14 }, () => ({ kind: "system", id: "fusion-system" })));
    expect(actors).not.toContainEqual(expect.objectContaining({ kind: "human" }));
    expect(directGlobal.defaultModelId).toBe("direct-attribution-model");
  });

  it("round-trips every explicit provenance variant through committed JSONB revisions", async () => {
    const store = h.store();
    const before = await revisionActors();
    const actors: ConfigChangedBy[] = [
      { kind: "human", id: "future-auth-user" },
      { kind: "agent", id: "agent-1" },
      { kind: "system", id: "system-test" },
      { kind: "api", id: "http:test-verified" },
      { kind: "rollback", id: "rollback-test" },
    ];

    for (const [index, actor] of actors.entries()) {
      await store.updateSettings({ taskPrefix: `ATR${index}` }, actor);
    }

    expect((await revisionActors()).slice(before.length)).toEqual(actors);
  });
});
