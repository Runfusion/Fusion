/**
 * FNXC:PostgresWorkflowAuthority 2026-07-14-17:52:
 * Workflow lifecycle guards, legacy-column evacuation, and settings exports must read PostgreSQL as the source of truth. These regressions exercise the public TaskStore and export seams so a synchronous empty fallback cannot silently bypass production behavior.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../builtin-coding-workflow-ir.js";
import { exportSettings } from "../../settings-export.js";
import type { WorkflowIrV2 } from "../../workflow-ir-types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

function workflowWithCustomColumn(): WorkflowIrV2 {
  const ir = structuredClone(BUILTIN_CODING_WORKFLOW_IR) as WorkflowIrV2;
  ir.name = "postgres-authoritative-workflow";
  ir.columns.push({ id: "custom-hold", name: "Custom hold", traits: [] });
  return ir;
}

pgDescribe("PostgreSQL workflow authoritative reads", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workflow_authority",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("blocks removal of a PostgreSQL-occupied workflow column", async () => {
    const store = h.store();
    /*
    FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
    The `experimentalFeatures: { workflowColumns: true }` write is DELETED. It was the
    only way this test reached the guard, and it is a configuration no production
    project has — so this case passed while the guard was inert for every real
    operator. The guard is no longer flag-gated, so the test now runs in the
    production shape and means what it always claimed to mean.
    */
    const ir = workflowWithCustomColumn();
    const workflow = await store.createWorkflowDefinition({ name: "Occupancy", ir, layout: {} });
    const task = await store.createTask({ description: "occupies custom column" });
    await store.selectTaskWorkflow(task.id, workflow.id);
    await store.moveTask(task.id, "custom-hold", { moveSource: "engine", bypassGuards: true, recoveryRehome: true });

    expect(await store.listWorkflowOccupantTaskIds(workflow.id, false)).toEqual([task.id]);
    expect(await store.occupantsByColumnForWorkflow(workflow.id, false)).toEqual(
      new Map([["custom-hold", 1]]),
    );

    const nextIr = structuredClone(ir);
    nextIr.columns = nextIr.columns.filter((column) => column.id !== "custom-hold");
    await expect(store.updateWorkflowDefinition(workflow.id, { ir: nextIr })).rejects.toMatchObject({
      name: "OccupiedColumnsError",
      workflowId: workflow.id,
    });
  });

  /*
  FNXC:WorkflowColumns 2026-07-28-00:00 (U12 — R9):
  "evacuates PostgreSQL custom-column cards to the legacy entry column" is DELETED
  with `evacuateCustomColumnsToLegacy`. It was the only caller of that method left
  anywhere, and it reached it by writing `experimentalFeatures.workflowColumns: true`
  itself — the flag no production writer sets. It proved a rollback path out of a
  runtime that is no longer opt-in.
  */
  it("lists and exports project-scoped PostgreSQL workflow setting values", async () => {
    const store = h.store();
    const projectId = store.getWorkflowSettingsProjectId();
    const settingUpdate = new Promise<{
      workflowId: string;
      projectId: string;
      settingIds: string[];
      mutationId: string;
    }>((resolve) => store.once("workflow:setting-values-updated", resolve));
    await store.updateWorkflowSettingValues("builtin:coding", projectId, {
      workflowStepTimeoutMs: 420_000,
    });

    await expect(settingUpdate).resolves.toMatchObject({
      workflowId: "builtin:coding",
      projectId,
      settingIds: ["workflowStepTimeoutMs"],
      mutationId: expect.any(String),
    });

    const expected = {
      "builtin:coding": { workflowStepTimeoutMs: 420_000 },
    };
    expect(await store.listWorkflowSettingValuesForProject()).toEqual(expected);
    expect((await exportSettings(store, { scope: "project" })).workflowSettings).toEqual(expected);
  });
});
