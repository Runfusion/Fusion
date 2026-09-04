import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import type { TaskStore } from "../../store.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../workflows/builtin-coding-workflow-ir.js";
import type { WorkflowDefinition } from "../../workflows/workflow-definition-types.js";

pgDescribe("workflow definition list/get coherence", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_workflow_coherence",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function secondStore(): Promise<TaskStore> {
    const { TaskStore: TaskStoreCtor } = await import("../../store.js");
    return new TaskStoreCtor(h.rootDir(), undefined, { asyncLayer: h.layer() });
  }

  async function seedWorkflow(id: string, description: string): Promise<void> {
    const now = "2026-09-01T00:00:00.000Z";
    await h.layer().db.insert(schema.project.workflows).values({
      id,
      name: "Coherence workflow",
      description,
      icon: "🔄",
      ir: BUILTIN_CODING_WORKFLOW_IR as unknown as object,
      layout: { positions: { triage: { x: 1, y: 2 } } },
      kind: "workflow",
      createdAt: now,
      updatedAt: now,
    });
  }

  function storedFields(definition: WorkflowDefinition | undefined) {
    if (!definition) return definition;
    const { name, description, icon, kind, ir, layout, updatedAt } = definition;
    return { name, description, icon, kind, ir, layout, updatedAt };
  }

  it("observes another TaskStore instance's committed update through both reads", async () => {
    const storeA = h.store();
    const storeB = await secondStore();
    const id = "WF-COHERENCE-UPDATE";
    await seedWorkflow(id, "plugin workflow v0.75.0");

    await storeA.listWorkflowDefinitions({ includeDisabledBuiltins: true });
    const updatedIr = structuredClone(BUILTIN_CODING_WORKFLOW_IR);
    updatedIr.name = "plugin workflow v0.79.0";
    await storeB.updateWorkflowDefinition(id, {
      description: "plugin workflow v0.79.0",
      ir: updatedIr,
    });

    const listed = (await storeA.listWorkflowDefinitions({ includeDisabledBuiltins: true }))
      .find((definition) => definition.id === id);
    const fetched = await storeA.getWorkflowDefinition(id);
    expect(listed?.description).toBe("plugin workflow v0.79.0");
    expect(listed?.description).not.toBe("plugin workflow v0.75.0");
    expect(storedFields(listed)).toEqual(storedFields(fetched));
    expect(listed?.ir).toEqual(updatedIr);
  });

  it("observes another TaskStore instance's create through the listing path", async () => {
    const storeA = h.store();
    const storeB = await secondStore();
    await storeA.listWorkflowDefinitions({ includeDisabledBuiltins: true });

    const created = await storeB.createWorkflowDefinition({
      name: "Created by second store",
      description: "created out of band",
      icon: "✨",
      ir: BUILTIN_CODING_WORKFLOW_IR,
      layout: { positions: { triage: { x: 3, y: 4 } } },
    });

    const listed = (await storeA.listWorkflowDefinitions({ includeDisabledBuiltins: true }))
      .find((definition) => definition.id === created.id);
    expect(storedFields(listed)).toEqual(storedFields(await storeA.getWorkflowDefinition(created.id)));
  });

  it("observes another TaskStore instance's delete through the listing path", async () => {
    const storeA = h.store();
    const storeB = await secondStore();
    const id = "WF-COHERENCE-DELETE";
    await seedWorkflow(id, "delete out of band");

    await storeA.listWorkflowDefinitions({ includeDisabledBuiltins: true });
    await storeB.deleteWorkflowDefinition(id);

    expect((await storeA.listWorkflowDefinitions({ includeDisabledBuiltins: true }))
      .find((definition) => definition.id === id)).toBeUndefined();
    expect(await storeA.getWorkflowDefinition(id)).toBeUndefined();
  });

  it("retains builtin definitions for a project with no custom workflow rows", async () => {
    const storeA = h.store();
    const listed = await storeA.listWorkflowDefinitions({ includeDisabledBuiltins: true });

    expect(listed.length).toBeGreaterThan(0);
    expect(listed.find((definition) => definition.id === "builtin:coding"))
      .toEqual(await storeA.getWorkflowDefinition("builtin:coding"));
  });
});
