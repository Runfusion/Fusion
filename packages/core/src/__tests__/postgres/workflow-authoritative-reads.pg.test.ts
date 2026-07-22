/**
 * FNXC:PostgresWorkflowAuthority 2026-07-14-17:52:
 * Workflow lifecycle guards, legacy-column evacuation, and settings exports must read PostgreSQL as the source of truth. These regressions exercise the public TaskStore and export seams so a synchronous empty fallback cannot silently bypass production behavior.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../workflows/builtin-coding-workflow-ir.js";
import { exportSettings } from "../../config/settings-export.js";
import type { WorkflowIrV2 } from "../../workflows/workflow-ir-types.js";
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
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
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

  it("evacuates PostgreSQL custom-column cards to the legacy entry column", async () => {
    const store = h.store();
    await store.updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
    const ir = workflowWithCustomColumn();
    const workflow = await store.createWorkflowDefinition({ name: "Evacuation", ir, layout: {} });
    const task = await store.createTask({ description: "must evacuate" });
    await store.selectTaskWorkflow(task.id, workflow.id);
    await store.moveTask(task.id, "custom-hold", { moveSource: "engine", bypassGuards: true, recoveryRehome: true });

    expect(await store.evacuateCustomColumnsToLegacy("flag-toggled-off")).toEqual({
      scanned: 1,
      evacuated: 1,
    });
    expect((await store.getTask(task.id)).column).toBe("triage");
  });

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
