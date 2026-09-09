import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import { TaskStore } from "../../store.js";
import { readProjectConfig, writeProjectConfig } from "../../task-store/async/async-settings.js";
import { __setBeforeScriptMutationCommitForTesting } from "../../task-store/script-ops.js";
import { __setAfterProjectConfigurationLockForTesting } from "../../task-store/settings-ops.js";
import { __setAfterWorkflowDefinitionLockForTesting } from "../../task-store/workflow-ops.js";

pgDescribe("atomic terminal script mutations", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_script_ops" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(async () => {
    __setBeforeScriptMutationCommitForTesting(undefined);
    __setAfterProjectConfigurationLockForTesting(undefined);
    __setAfterWorkflowDefinitionLockForTesting(undefined);
    await h.afterEach();
  });
  afterAll(h.afterAll);

  const now = "2026-09-06T19:30:00.000Z";
  const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });
  const storeFor = (projectId: string) => new TaskStore(h.rootDir(), undefined, { asyncLayer: bind(projectId) });

  async function seed(projectId: string): Promise<void> {
    const layer = bind(projectId);
    await writeProjectConfig(layer, {
      scripts: { build: "pnpm build", occupied: "echo occupied" },
      scriptMetadata: { build: { description: "Legacy build" } },
      setupScript: "build",
    });
    await layer.db.insert(schema.project.workflowSteps).values({
      projectId, id: "WS-001", name: "Build", description: "", mode: "script", phase: "pre-merge",
      prompt: "", gateMode: "gate", scriptName: "build", enabled: 1, createdAt: now, updatedAt: now,
    });
    await layer.db.insert(schema.project.workflows).values({
      projectId, id: "WF-001", name: "Nested", description: "", kind: "workflow", layout: {}, createdAt: now, updatedAt: now,
      ir: {
        version: "v2", name: "Nested", columns: [{ id: "work", name: "Work", traits: [] }],
        nodes: [
          { id: "start", kind: "start" },
          { id: "top", kind: "script", config: { scriptName: "build" } },
          { id: "loop", kind: "loop", config: {
            maxIterations: 2,
            exitWhen: { type: "output-contains", value: "done" },
            template: { nodes: [
              { id: "deep", kind: "script", config: { scriptName: "build" } },
            ], edges: [] },
          } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "top" },
          { from: "top", to: "loop" },
          { from: "loop", to: "end" },
        ],
      },
    });
  }

  it("renames the complete catalog and references in one project only", async () => {
    await seed("script-project-a");
    await seed("script-project-b");
    const store = storeFor("script-project-a");
    const events: unknown[] = [];
    store.on("settings:updated", (event) => events.push(event));

    await expect(store.mutateScript({
      originalName: "build", name: "Build production", command: "pnpm build", description: " Bundle de production ",
    })).resolves.toContainEqual({
      name: "Build production", command: "pnpm build", description: "Bundle de production",
    });

    const configA = await readProjectConfig(bind("script-project-a"));
    expect(configA.settings).toMatchObject({
      scripts: { "Build production": "pnpm build", occupied: "echo occupied" },
      scriptMetadata: { "Build production": { description: "Bundle de production" } },
      setupScript: "Build production",
    });
    expect((configA.settings?.scripts as Record<string, string>).build).toBeUndefined();
    const [stepA] = await bind("script-project-a").db.select().from(schema.project.workflowSteps)
      .where(and(eq(schema.project.workflowSteps.projectId, "script-project-a"), eq(schema.project.workflowSteps.id, "WS-001")));
    expect(stepA?.scriptName).toBe("Build production");
    const [workflowA] = await bind("script-project-a").db.select({ ir: schema.project.workflows.ir }).from(schema.project.workflows)
      .where(and(eq(schema.project.workflows.projectId, "script-project-a"), eq(schema.project.workflows.id, "WF-001")));
    expect(JSON.stringify(workflowA?.ir).match(/Build production/g)).toHaveLength(2);
    expect(events).toHaveLength(1);

    const configB = await readProjectConfig(bind("script-project-b"));
    expect(configB.settings).toMatchObject({ scripts: { build: "pnpm build" }, setupScript: "build" });
    const [stepB] = await bind("script-project-b").db.select().from(schema.project.workflowSteps)
      .where(and(eq(schema.project.workflowSteps.projectId, "script-project-b"), eq(schema.project.workflowSteps.id, "WS-001")));
    expect(stepB?.scriptName).toBe("build");
    const [workflowB] = await bind("script-project-b").db.select({ ir: schema.project.workflows.ir }).from(schema.project.workflows)
      .where(and(eq(schema.project.workflows.projectId, "script-project-b"), eq(schema.project.workflows.id, "WF-001")));
    expect(JSON.stringify(workflowB?.ir).match(/"scriptName":"build"/g)).toHaveLength(2);
  });

  it("serializes rename before a concurrent settings writer without restoring the old catalog", async () => {
    await seed("script-project-settings-after");
    const renameStore = storeFor("script-project-settings-after");
    const settingsStore = storeFor("script-project-settings-after");
    let releaseRename!: () => void;
    const renameHeld = new Promise<void>((resolve) => { releaseRename = resolve; });
    let renameReached!: () => void;
    const renameReady = new Promise<void>((resolve) => { renameReached = resolve; });
    __setBeforeScriptMutationCommitForTesting(async () => {
      renameReached();
      await renameHeld;
    });

    const rename = renameStore.mutateScript({ originalName: "build", name: "Build production", command: "pnpm build" });
    await renameReady;
    let settingsSettled = false;
    const settingsWrite = settingsStore.updateSettings({ maxConcurrent: 7 }).then(() => { settingsSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settingsSettled).toBe(false);
    releaseRename();
    await Promise.all([rename, settingsWrite]);

    expect((await readProjectConfig(bind("script-project-settings-after"))).settings).toMatchObject({
      scripts: { "Build production": "pnpm build", occupied: "echo occupied" },
      setupScript: "Build production",
      maxConcurrent: 7,
    });
  });

  it("serializes rename after a concurrent settings writer and preserves both mutations", async () => {
    await seed("script-project-settings-before");
    const renameStore = storeFor("script-project-settings-before");
    const settingsStore = storeFor("script-project-settings-before");
    let releaseSettings!: () => void;
    const settingsHeld = new Promise<void>((resolve) => { releaseSettings = resolve; });
    let settingsReached!: () => void;
    const settingsReady = new Promise<void>((resolve) => { settingsReached = resolve; });
    __setAfterProjectConfigurationLockForTesting(async () => {
      settingsReached();
      await settingsHeld;
    });

    const settingsWrite = settingsStore.updateSettings({ maxConcurrent: 9 });
    await settingsReady;
    let renameSettled = false;
    const rename = renameStore.mutateScript({ originalName: "build", name: "Build production", command: "pnpm build" })
      .then(() => { renameSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(renameSettled).toBe(false);
    releaseSettings();
    await Promise.all([settingsWrite, rename]);

    expect((await readProjectConfig(bind("script-project-settings-before"))).settings).toMatchObject({
      scripts: { "Build production": "pnpm build", occupied: "echo occupied" },
      setupScript: "Build production",
      maxConcurrent: 9,
    });
  });

  it("serializes a concurrent workflow edit behind rename and preserves the renamed reference", async () => {
    await seed("script-project-workflow-concurrent");
    const renameStore = storeFor("script-project-workflow-concurrent");
    const workflowStore = storeFor("script-project-workflow-concurrent");
    let releaseRename!: () => void;
    const renameHeld = new Promise<void>((resolve) => { releaseRename = resolve; });
    let renameReached!: () => void;
    const renameReady = new Promise<void>((resolve) => { renameReached = resolve; });
    __setBeforeScriptMutationCommitForTesting(async () => {
      renameReached();
      await renameHeld;
    });

    const rename = renameStore.mutateScript({ originalName: "build", name: "Build production", command: "pnpm build" });
    await renameReady;
    let workflowSettled = false;
    const workflowWrite = workflowStore.updateWorkflowStep("WS-001", { description: "Edited concurrently" })
      .then(() => { workflowSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(workflowSettled).toBe(false);
    releaseRename();
    await Promise.all([rename, workflowWrite]);

    const [step] = await bind("script-project-workflow-concurrent").db.select().from(schema.project.workflowSteps).where(and(
      eq(schema.project.workflowSteps.projectId, "script-project-workflow-concurrent"),
      eq(schema.project.workflowSteps.id, "WS-001"),
    ));
    expect(step?.description).toBe("Edited concurrently");
    expect(step?.scriptName).toBe("Build production");
    const [workflow] = await bind("script-project-workflow-concurrent").db.select({ ir: schema.project.workflows.ir })
      .from(schema.project.workflows).where(and(
        eq(schema.project.workflows.projectId, "script-project-workflow-concurrent"),
        eq(schema.project.workflows.id, "WF-001"),
      ));
    expect(JSON.stringify(workflow?.ir).match(/Build production/g)).toHaveLength(2);
  });

  it("rejects a stale graph save that resumes after a rename", async () => {
    await seed("script-project-graph-after");
    const renameStore = storeFor("script-project-graph-after");
    const workflowStore = storeFor("script-project-graph-after");
    const staleWorkflow = await workflowStore.getWorkflowDefinition("WF-001");
    expect(staleWorkflow).toBeDefined();
    const staleIr = structuredClone(staleWorkflow!.ir);
    staleIr.name = "Stale editor save";

    let releaseRename!: () => void;
    const renameHeld = new Promise<void>((resolve) => { releaseRename = resolve; });
    let renameReached!: () => void;
    const renameReady = new Promise<void>((resolve) => { renameReached = resolve; });
    __setBeforeScriptMutationCommitForTesting(async () => {
      renameReached();
      await renameHeld;
    });

    const rename = renameStore.mutateScript({ originalName: "build", name: "Build production", command: "pnpm build" });
    await renameReady;
    const staleSave = workflowStore.updateWorkflowDefinition("WF-001", { ir: staleIr })
      .then(() => ({ status: "fulfilled" as const }), (error: unknown) => ({ status: "rejected" as const, error }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRename();
    await rename;

    const staleOutcome = await staleSave;
    expect(staleOutcome).toMatchObject({ status: "rejected", error: { message: expect.stringMatching(/changed.*reload/i) } });
    const saved = await workflowStore.getWorkflowDefinition("WF-001");
    expect(saved?.ir.name).toBe("Nested");
    expect(JSON.stringify(saved?.ir).match(/Build production/g)).toHaveLength(2);
    expect(JSON.stringify(saved?.ir)).not.toContain('"scriptName":"build"');
  });

  it("rejects an editor IR loaded before a rename that has already completed", async () => {
    await seed("script-project-graph-loaded-before");
    const store = storeFor("script-project-graph-loaded-before");
    const loadedBeforeRename = await store.getWorkflowDefinition("WF-001");
    expect(loadedBeforeRename).toBeDefined();
    const staleIr = structuredClone(loadedBeforeRename!.ir);
    staleIr.name = "Saved by stale editor";

    await store.mutateScript({
      originalName: "build",
      name: "Build production",
      command: "pnpm build",
      description: "Production build",
    });

    await expect(store.updateWorkflowDefinition("WF-001", { ir: staleIr }))
      .rejects.toThrow(/script.*changed.*reload/i);
    const saved = await store.getWorkflowDefinition("WF-001");
    expect(saved?.ir.name).toBe("Nested");
    expect(JSON.stringify(saved?.ir).match(/Build production/g)).toHaveLength(2);
    expect(JSON.stringify(saved?.ir)).not.toContain('"scriptName":"build"');
    expect((await readProjectConfig(bind("script-project-graph-loaded-before"))).settings).toMatchObject({
      scripts: { "Build production": "pnpm build", occupied: "echo occupied" },
      scriptMetadata: { "Build production": { description: "Production build" } },
      setupScript: "Build production",
    });
  });

  it("lets rename reconcile a graph save that commits first", async () => {
    await seed("script-project-graph-before");
    const renameStore = storeFor("script-project-graph-before");
    const workflowStore = storeFor("script-project-graph-before");
    const editedWorkflow = await workflowStore.getWorkflowDefinition("WF-001");
    expect(editedWorkflow).toBeDefined();
    const editedIr = structuredClone(editedWorkflow!.ir);
    editedIr.name = "Editor save first";

    let releaseWorkflow!: () => void;
    const workflowHeld = new Promise<void>((resolve) => { releaseWorkflow = resolve; });
    let workflowReached!: () => void;
    const workflowReady = new Promise<void>((resolve) => { workflowReached = resolve; });
    __setAfterWorkflowDefinitionLockForTesting(async () => {
      workflowReached();
      await workflowHeld;
    });

    const workflowSave = workflowStore.updateWorkflowDefinition("WF-001", { ir: editedIr });
    await workflowReady;
    let renameSettled = false;
    const rename = renameStore.mutateScript({ originalName: "build", name: "Build production", command: "pnpm build" })
      .then(() => { renameSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(renameSettled).toBe(false);
    releaseWorkflow();
    await Promise.all([workflowSave, rename]);

    const saved = await workflowStore.getWorkflowDefinition("WF-001");
    expect(saved?.ir.name).toBe("Editor save first");
    expect(JSON.stringify(saved?.ir).match(/Build production/g)).toHaveLength(2);
    expect(JSON.stringify(saved?.ir)).not.toContain('"scriptName":"build"');
  });

  it("rolls back settings and every reference when the final write boundary fails", async () => {
    await seed("script-project-rollback");
    const layer = bind("script-project-rollback");
    const store = storeFor("script-project-rollback");
    __setBeforeScriptMutationCommitForTesting(() => { throw new Error("injected pre-commit failure"); });
    await expect(store.mutateScript({
      originalName: "build", name: "Build production", command: "changed", description: "Changed",
    })).rejects.toThrow("injected pre-commit failure");

    expect((await readProjectConfig(layer)).settings).toMatchObject({
      scripts: { build: "pnpm build" }, scriptMetadata: { build: { description: "Legacy build" } }, setupScript: "build",
    });
    const [step] = await layer.db.select().from(schema.project.workflowSteps)
      .where(and(eq(schema.project.workflowSteps.projectId, "script-project-rollback"), eq(schema.project.workflowSteps.id, "WS-001")));
    expect(step?.scriptName).toBe("build");
    const [workflow] = await layer.db.select({ ir: schema.project.workflows.ir }).from(schema.project.workflows)
      .where(and(eq(schema.project.workflows.projectId, "script-project-rollback"), eq(schema.project.workflows.id, "WF-001")));
    expect(JSON.stringify(workflow?.ir).match(/"scriptName":"build"/g)).toHaveLength(2);
  });

  it("rejects a collision without partial writes and removes empty metadata", async () => {
    await seed("script-project-conflict");
    const store = storeFor("script-project-conflict");
    await expect(store.mutateScript({ originalName: "build", name: "occupied", command: "changed" }))
      .rejects.toMatchObject({ code: "SCRIPT_NAME_CONFLICT" });
    await expect(store.mutateScript({ name: "occupied", command: "changed" }))
      .rejects.toMatchObject({ code: "SCRIPT_NAME_CONFLICT" });
    expect((await readProjectConfig(bind("script-project-conflict"))).settings).toMatchObject({
      scripts: { build: "pnpm build", occupied: "echo occupied" }, setupScript: "build",
      scriptMetadata: { build: { description: "Legacy build" } },
    });

    await store.mutateScript({ originalName: "build", name: "build", command: "pnpm build", description: "   " });
    expect((await readProjectConfig(bind("script-project-conflict"))).settings).not.toHaveProperty("scriptMetadata.build");
    await store.mutateScript({ originalName: "build", name: "build", delete: true });
    const finalSettings = (await readProjectConfig(bind("script-project-conflict"))).settings;
    expect(finalSettings?.scripts).toEqual({ occupied: "echo occupied" });
    expect(finalSettings).not.toHaveProperty("scriptMetadata.build");
  });
});
