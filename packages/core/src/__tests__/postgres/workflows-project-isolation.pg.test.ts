import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { getWorkflowRow, listWorkflowRows } from "../../async-stores/async-workflow-store.js";
import { aggregateWorkflowAnalytics } from "../../board/workflow-analytics.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import type { TaskStore } from "../../store.js";
import { writeProjectConfig } from "../../task-store/async/async-settings.js";
import { nextWorkflowDefinitionIdAsyncImpl } from "../../task-store/workflow-definitions.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../workflows/builtin-coding-workflow-ir.js";

pgDescribe("workflows project isolation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workflows_isolation",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  const now = "2026-08-12T03:02:00.000Z";
  const ir = BUILTIN_CODING_WORKFLOW_IR as unknown as object;
  const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
  const boundStore = async (projectId: string): Promise<TaskStore> => {
    const { TaskStore: TaskStoreCtor } = await import("../../store.js");
    return new TaskStoreCtor(h.rootDir(), undefined, { asyncLayer: bind(projectId) });
  };

  async function insertWorkflow(
    layer: AsyncDataLayer,
    id: string,
    name: string,
    workflowIr: object = ir,
  ): Promise<void> {
    await layer.db.insert(schema.project.workflows).values({
      ...(layer.projectId?.trim() ? { projectId: layer.projectId } : {}),
      id, name, description: "", icon: null, ir: workflowIr, layout: {}, kind: "workflow", createdAt: now, updatedAt: now,
    });
  }

  it("models the live 0006 ownership shape exactly", async () => {
    const columns = await h.adminSql()<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'workflows' AND column_name = 'project_id'
    `;
    expect(columns).toEqual([expect.objectContaining({
      column_name: "project_id", data_type: "text", is_nullable: "NO",
      column_default: expect.stringContaining("current_setting"),
    })]);
    const keys = await h.adminSql()<Array<{ conname: string; columns: string[] }>>`
      SELECT c.conname, array_agg(a.attname ORDER BY k.ordinality) AS columns
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = 'project.workflows'::regclass AND c.contype = 'p'
      GROUP BY c.conname
    `;
    expect(keys).toEqual([{ conname: "workflows_pkey", columns: ["project_id", "id"] }]);
    expect(await h.adminSql()<Array<{ polname: string }>>`
      SELECT polname FROM pg_policy WHERE polrelid = 'project.workflows'::regclass
    `).toEqual([{ polname: "fusion_project_isolation" }]);
    expect(await h.adminSql()<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'project.workflows'::regclass
        AND NOT tgisinternal
    `).toEqual([{ tgname: "fusion_assign_project_id" }]);
  });

  it("isolates colliding workflow reads, writes, deletes, analytics, and preserves unbound compatibility", async () => {
    /*
    FNXC:WorkflowDefinitionProjectIsolation 2026-08-12-03:02:
    Duplicate WF IDs are expected because counters are per project. These assertions exercise
    owner-connected layers, where RLS is bypassed and each application predicate must preserve
    the foreign workflow plus its companion settings and prompt overrides.
    */
    const projectA = bind("workflows-project-a");
    const projectB = bind("workflows-project-b");
    const foreignIr = { foreign: "project-b-workflow-ir" };
    await insertWorkflow(projectA, "WF-003", "Project A flow");
    await insertWorkflow(projectA, "WF-005", "Project A only");
    await insertWorkflow(projectB, "WF-003", "Project B flow", foreignIr);
    await insertWorkflow(projectB, "WF-004", "Project B only");
    for (const layer of [projectA, projectB]) {
      await layer.db.insert(schema.project.workflowSettings).values({ workflowId: "WF-003", projectId: layer.projectId!, values: {}, updatedAt: now });
      await layer.db.insert(schema.project.workflowPromptOverrides).values({ workflowId: "WF-003", projectId: layer.projectId!, overrides: {}, updatedAt: now });
    }

    expect((await listWorkflowRows(projectA)).map((row) => row.id)).toEqual(["WF-003", "WF-005"]);
    expect((await listWorkflowRows(projectB)).map((row) => row.id)).toEqual(["WF-003", "WF-004"]);
    expect(await getWorkflowRow(projectA, "WF-003")).toMatchObject({ id: "WF-003", name: "Project A flow" });
    expect(await getWorkflowRow(projectB, "WF-003")).toMatchObject({ id: "WF-003", name: "Project B flow" });
    expect("projectId" in (await getWorkflowRow(projectA, "WF-003"))!).toBe(false);
    expect(await listWorkflowRows(bind("workflows-empty"))).toEqual([]);

    const storeA = await boundStore(projectA.projectId!);
    await storeA.createTaskWithReservedId(
      { description: "Analytics workflow name fixture", column: "done", workflowId: "WF-003" },
      { taskId: "FN-WORKFLOW-ANALYTICS", createdAt: now, updatedAt: now, applyDefaultWorkflowSteps: false },
    );
    await projectA.db.update(schema.project.tasks).set({ columnMovedAt: now })
      .where(and(eq(schema.project.tasks.id, "FN-WORKFLOW-ANALYTICS"), eq(schema.project.tasks.projectId, projectA.projectId!)));
    const analytics = await aggregateWorkflowAnalytics(projectA, {
      from: "2026-08-12T00:00:00.000Z",
      to: "2026-08-12T23:59:59.999Z",
    });
    expect(analytics.workflows).toContainEqual(expect.objectContaining({
      workflowId: "WF-003", workflowName: "Project A flow", tasksCompleted: 1,
    }));

    await storeA.updateWorkflowDefinition("WF-003", { description: "A updated" });
    expect(await getWorkflowRow(projectA, "WF-003")).toMatchObject({ description: "A updated" });
    expect(await getWorkflowRow(projectB, "WF-003")).toMatchObject({
      name: "Project B flow", description: "", ir: JSON.stringify(foreignIr), updatedAt: now,
    });
    expect(await projectB.db.select({ ir: schema.project.workflows.ir }).from(schema.project.workflows)
      .where(and(eq(schema.project.workflows.id, "WF-003"), eq(schema.project.workflows.projectId, projectB.projectId!))))
      .toEqual([{ ir: foreignIr }]);

    await storeA.deleteWorkflowDefinition("WF-003");
    expect(await getWorkflowRow(projectA, "WF-003")).toBeUndefined();
    expect(await projectA.db.select().from(schema.project.workflowSettings).where(and(eq(schema.project.workflowSettings.workflowId, "WF-003"), eq(schema.project.workflowSettings.projectId, projectA.projectId!)))).toEqual([]);
    expect(await projectA.db.select().from(schema.project.workflowPromptOverrides).where(and(eq(schema.project.workflowPromptOverrides.workflowId, "WF-003"), eq(schema.project.workflowPromptOverrides.projectId, projectA.projectId!)))).toEqual([]);
    expect(await getWorkflowRow(projectB, "WF-003")).toMatchObject({
      name: "Project B flow", ir: JSON.stringify(foreignIr),
    });
    expect(await projectB.db.select().from(schema.project.workflowSettings).where(and(eq(schema.project.workflowSettings.workflowId, "WF-003"), eq(schema.project.workflowSettings.projectId, projectB.projectId!)))).toHaveLength(1);
    expect(await projectB.db.select().from(schema.project.workflowPromptOverrides).where(and(eq(schema.project.workflowPromptOverrides.workflowId, "WF-003"), eq(schema.project.workflowPromptOverrides.projectId, projectB.projectId!)))).toHaveLength(1);
    await expect(storeA.deleteWorkflowDefinition("WF-004")).rejects.toThrow("Workflow 'WF-004' not found");

    const unbound = { ...h.layer(), projectId: "" } satisfies AsyncDataLayer;
    expect((await listWorkflowRows(unbound)).map((row) => row.name)).toEqual(["Project A only", "Project B flow", "Project B only"]);
    await insertWorkflow(unbound, "WF-006", "Unbound trigger stamped");
    const unboundStored = await unbound.db.select({ projectId: schema.project.workflows.projectId })
      .from(schema.project.workflows).where(eq(schema.project.workflows.id, "WF-006"));
    expect(unboundStored[0]?.projectId).toBe("__legacy_unscoped__");

    await writeProjectConfig(projectA, {}, { nextWorkflowDefinitionId: 2 });
    expect(await nextWorkflowDefinitionIdAsyncImpl(storeA)).toBe("WF-007");
  });
});
